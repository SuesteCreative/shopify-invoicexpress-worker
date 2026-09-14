import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Every `prepare(...).bind(...)` has to bind as many values as the statement has
 * placeholders.
 *
 * D1 refuses the statement when it does not, at runtime, on the row it was about
 * to write. The Stripe webhook swallows handler errors and answers 200 by
 * design, so a missing bind there is invisible: `a19f25d` added the
 * `connection_key` column and its placeholder to the subscription upsert without
 * adding the value, and every `customer.subscription.*` event — renewals,
 * cancellations, plan changes — was refused for days with Stripe reporting
 * success on all of them.
 *
 * Cheap to check statically, so it is checked statically.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The writers of `subscriptions`, which is where this already went wrong, and
 * the writers of `connections`, which is where the next one would: those routes
 * are the ones a settings save goes through, and a refused UPDATE there leaves a
 * merchant's integration silently unchanged.
 */
const FILES = [
    "../app/api/webhooks/stripe/route.ts",
    "../app/api/admin/subscription/route.ts",
    "../app/api/admin/onboarding-invites/route.ts",
    "../app/api/onboarding/invite/claim/route.ts",
    "./link-subscription.ts",
    "../app/api/integrations/route.ts",
    "../app/api/integrations/stripe-source/route.ts",
    "../app/api/integrations/lodgify-source/route.ts",
    "../app/api/integrations/eupago-source/route.ts",
    "../app/api/integrations/moloni-destination/route.ts",
    "../app/api/integrations/vendus-destination/route.ts",
];

interface Statement {
    sql: string | null;
    placeholders: number;
    bound: number;
    line: number;
    /** Set when the statement was seen but cannot be checked statically. */
    unchecked: string | null;
}

/** Split on commas that are not inside a nested call, string or template. */
function countTopLevelArgs(src: string, start: number): { count: number; end: number } {
    let depth = 1;
    let count = 0;
    let seenValue = false;
    let i = start;
    while (i < src.length && depth > 0) {
        const c = src[i];
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") {
            depth--;
            if (depth === 0) break;
        } else if (c === '"' || c === "'" || c === "`") {
            const quote = c;
            i++;
            while (i < src.length && src[i] !== quote) i += src[i] === "\\" ? 2 : 1;
        } else if (c === "/" && src[i + 1] === "/") {
            // Prose inside the bind list has commas in it; they are not arguments.
            i = src.indexOf("\n", i);
            if (i === -1) break;
            continue;
        } else if (c === "/" && src[i + 1] === "*") {
            const close = src.indexOf("*/", i + 2);
            if (close === -1) break;
            i = close + 2;
            continue;
        } else if (c === "," && depth === 1) {
            count++;
            seenValue = false;
            i++;
            continue;
        } else if (!/\s/.test(c)) {
            seenValue = true;
        }
        i++;
    }
    // A trailing comma leaves `seenValue` false: the repo writes them, and they
    // are not an argument.
    return { count: seenValue ? count + 1 : count, end: i };
}

/**
 * Past whatever separates the SQL from `.bind(`: whitespace, the closing paren,
 * and prose. A scanner that stops at the first comment stops silently, and the
 * `integrations` UPDATE carries a paragraph between the two — so the one
 * statement most likely to grow a column was the one never checked.
 */
function skipGap(src: string, i: number): number {
    for (;;) {
        while (i < src.length && /[\s)]/.test(src[i])) i++;
        if (src[i] === "/" && src[i + 1] === "/") {
            const nl = src.indexOf("\n", i);
            if (nl === -1) return src.length;
            i = nl + 1;
            continue;
        }
        if (src[i] === "/" && src[i + 1] === "*") {
            const close = src.indexOf("*/", i + 2);
            if (close === -1) return src.length;
            i = close + 2;
            continue;
        }
        return i;
    }
}

/**
 * The SQL literal at `i`, template or quoted. The repo writes both: reading only
 * backticks left 10 of the Stripe webhook's 21 statements unread, in the very
 * file this test was written for.
 *
 * Returns null when the argument is a variable, which is out of reach of a
 * static check.
 */
function readSqlLiteral(src: string, i: number): { sql: string; end: number } | null {
    const quote = src[i];
    if (quote !== "`" && quote !== '"' && quote !== "'") return null;
    let j = i + 1;
    while (j < src.length && src[j] !== quote) j += src[j] === "\\" ? 2 : 1;
    if (j >= src.length) return null;
    return { sql: src.slice(i + 1, j), end: j + 1 };
}

function statementsIn(source: string): Statement[] {
    const out: Statement[] = [];
    const marker = ".prepare(";
    let from = 0;
    for (;;) {
        const at = source.indexOf(marker, from);
        if (at === -1) break;
        from = at + marker.length;
        const line = source.slice(0, at).split("\n").length;

        // Every `.prepare(` is emitted, checkable or not. Dropping the ones it
        // cannot read is how a scanner reports success over a file it barely
        // looked at; the caller asserts the count instead.
        const lit = readSqlLiteral(source, skipGap(source, from));
        if (!lit) {
            out.push({ sql: null, placeholders: 0, bound: 0, line, unchecked: "SQL is not a literal" });
            continue;
        }
        from = lit.end;
        const placeholders = (lit.sql.match(/\?/g) ?? []).length;

        // Only statements bound right here. `.bind(...)` applied to a variable
        // elsewhere is out of reach of a static check, and saying so is better
        // than guessing.
        const j = skipGap(source, lit.end);
        if (!source.startsWith(".bind(", j)) {
            out.push({ sql: lit.sql, placeholders, bound: 0, line, unchecked: "bound elsewhere" });
            continue;
        }

        const { count } = countTopLevelArgs(source, j + ".bind(".length);
        out.push({ sql: lit.sql, placeholders, bound: count, line, unchecked: null });
    }
    return out;
}

describe("prepare().bind() arity", () => {
    for (const rel of FILES) {
        const source = readFileSync(resolve(HERE, rel), "utf8");
        const statements = statementsIn(source);
        const name = rel.split("/").slice(-2).join("/");

        it(`reads every statement in ${name}`, () => {
            // Coverage is the half of this test that can rot without a sound: a
            // scanner that skips what it cannot parse passes just as green over
            // a file it read none of.
            expect(statements.length).toBe((source.match(/\.prepare\(/g) ?? []).length);
        });

        it(`matches in ${name}`, () => {
            const checked = statements.filter((s) => !s.unchecked);
            expect(checked.length).toBeGreaterThan(0);
            for (const s of checked) {
                expect(
                    s.bound,
                    `${rel}:${s.line} — ${s.placeholders} placeholders, ${s.bound} valores: ${s.sql!.trim().slice(0, 70)}…`,
                ).toBe(s.placeholders);
            }
        });
    }

    it("counts a mismatch as a mismatch", () => {
        const fake = 'db.prepare(`INSERT INTO t (a, b) VALUES (?, ?)`).bind(one).run();';
        expect(statementsIn(fake)).toEqual([
            expect.objectContaining({ placeholders: 2, bound: 1, unchecked: null }),
        ]);
    });

    it("reads a quoted statement, not only a template literal", () => {
        const fake = 'db.prepare("UPDATE t SET a = ? WHERE id = ?").bind(a).run();';
        expect(statementsIn(fake)).toEqual([
            expect.objectContaining({ placeholders: 2, bound: 1, unchecked: null }),
        ]);
    });

    it("reads past prose between the SQL and the bind", () => {
        const fake = [
            "db.prepare(`UPDATE t SET a = ? WHERE id = ?`",
            "    // ABSENT MEANS UNCHANGED: the comma below is prose, not an argument.",
            ").bind(a).run();",
        ].join("\n");
        expect(statementsIn(fake)).toEqual([
            expect.objectContaining({ placeholders: 2, bound: 1, unchecked: null }),
        ]);
    });

    it("reports a statement it cannot read instead of dropping it", () => {
        const fake = "db.prepare(sql).bind(a, b).run();";
        expect(statementsIn(fake)).toEqual([
            expect.objectContaining({ unchecked: "SQL is not a literal" }),
        ]);
    });
});
