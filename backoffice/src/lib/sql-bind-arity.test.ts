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

/** The writers of `subscriptions`, which is where this already went wrong. */
const FILES = [
    "../app/api/webhooks/stripe/route.ts",
    "../app/api/admin/link-subscription/route.ts",
    "../app/api/admin/subscription/route.ts",
];

interface Statement { sql: string; placeholders: number; bound: number; line: number }

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

function statementsIn(source: string): Statement[] {
    const out: Statement[] = [];
    const marker = ".prepare(`";
    let from = 0;
    for (;;) {
        const at = source.indexOf(marker, from);
        if (at === -1) break;
        const sqlStart = at + marker.length;
        const sqlEnd = source.indexOf("`", sqlStart);
        if (sqlEnd === -1) break;
        const sql = source.slice(sqlStart, sqlEnd);
        from = sqlEnd + 1;

        // Only statements bound right here. `.bind(...)` applied to a variable
        // elsewhere is out of reach of a static check, and saying so is better
        // than guessing.
        const after = source.slice(sqlEnd + 1, sqlEnd + 40);
        const bindAt = after.indexOf(".bind(");
        if (bindAt === -1 || /[A-Za-z0-9_]/.test(after.slice(0, bindAt).replace(/[\s)]/g, ""))) continue;

        const argsStart = sqlEnd + 1 + bindAt + ".bind(".length;
        const { count } = countTopLevelArgs(source, argsStart);
        out.push({
            sql,
            placeholders: (sql.match(/\?/g) ?? []).length,
            bound: count,
            line: source.slice(0, at).split("\n").length,
        });
    }
    return out;
}

describe("prepare().bind() arity", () => {
    for (const rel of FILES) {
        it(`matches in ${rel.split("/").pop()}`, () => {
            const path = resolve(HERE, rel);
            const statements = statementsIn(readFileSync(path, "utf8"));
            expect(statements.length).toBeGreaterThan(0);
            for (const s of statements) {
                expect(
                    s.bound,
                    `${rel}:${s.line} — ${s.placeholders} placeholders, ${s.bound} valores: ${s.sql.trim().slice(0, 70)}…`,
                ).toBe(s.placeholders);
            }
        });
    }

    it("counts a mismatch as a mismatch", () => {
        const fake = 'db.prepare(`INSERT INTO t (a, b) VALUES (?, ?)`).bind(one).run();';
        expect(statementsIn(fake)).toEqual([
            expect.objectContaining({ placeholders: 2, bound: 1 }),
        ]);
    });
});
