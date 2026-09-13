import { describe, it, expect } from "vitest";
import { asLang, isLang, readAccountLanguage } from "./user-language";

/**
 * The language of an account, read the way the middleware reads it on every page
 * a signed-in client opens.
 *
 * Two things can go wrong here and neither is loud. An invited member reading
 * their OWN row instead of the account's would put two people who work in the
 * same company on two different languages. And a database where 0061 has not
 * landed yet must still open the dashboard — in Portuguese — rather than throw.
 *
 * The SQL runs against node:sqlite, like client-code.test.ts, so the join is
 * checked and not described.
 */

function harness(opts: { withColumn?: boolean } = {}) {
    const withColumn = opts.withColumn !== false;
    const nodeSqlite = "node:sqlite";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require(nodeSqlite);
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
        CREATE TABLE users (
            id TEXT PRIMARY KEY, email TEXT${withColumn ? ", language TEXT NOT NULL DEFAULT 'pt'" : ""}
        );
        CREATE TABLE account_members (
            id TEXT PRIMARY KEY, account_id TEXT, member_user_id TEXT, status TEXT
        );
    `);

    const db = {
        prepare(sql: string) {
            const stmt = sqlite.prepare(sql);
            let bound: unknown[] = [];
            const api = {
                bind(...args: unknown[]) { bound = args; return api; },
                async run() { const r = stmt.run(...bound); return { meta: { changes: Number(r.changes ?? 0) } }; },
                async first() { return stmt.get(...bound) ?? null; },
            };
            return api;
        },
    } as any;

    const user = (id: string, language?: string) => sqlite
        .prepare(withColumn ? "INSERT INTO users (id, email, language) VALUES (?, ?, ?)" : "INSERT INTO users (id, email) VALUES (?, ?)")
        .run(...(withColumn ? [id, `${id}@x.pt`, language ?? "pt"] : [id, `${id}@x.pt`]));
    const member = (accountId: string, memberId: string, status = "active") => sqlite
        .prepare("INSERT INTO account_members (id, account_id, member_user_id, status) VALUES (?, ?, ?, ?)")
        .run(`m-${memberId}`, accountId, memberId, status);

    return { db, user, member };
}

describe("what counts as a language", () => {
    it("is English only when it says so, and Portuguese for everything else", () => {
        expect(asLang("en")).toBe("en");
        expect(asLang("pt")).toBe("pt");
        // A typo, a null column, a value from before 0061: all Portuguese, which
        // is what every account received before this existed.
        expect(asLang("EN")).toBe("pt");
        expect(asLang(null)).toBe("pt");
        expect(asLang(undefined)).toBe("pt");
        expect(asLang("fr")).toBe("pt");
    });

    it("only accepts what the selector can produce", () => {
        expect(isLang("pt")).toBe(true);
        expect(isLang("en")).toBe(true);
        expect(isLang("")).toBe(false);
        expect(isLang("pt-PT")).toBe(false);
        expect(isLang(null)).toBe(false);
    });
});

describe("the language of the account", () => {
    it("is the owner's own choice", async () => {
        const h = harness();
        h.user("owner", "en");
        expect(await readAccountLanguage(h.db, "owner")).toBe("en");
    });

    it("follows the ACCOUNT for an invited member, not the member's own row", async () => {
        const h = harness();
        h.user("owner", "en");
        h.user("seat", "pt");
        h.member("owner", "seat");
        // One account, one language: the seat works inside the owner's company
        // and reads what that company reads.
        expect(await readAccountLanguage(h.db, "seat")).toBe("en");
    });

    it("ignores a membership that is not active", async () => {
        const h = harness();
        h.user("owner", "en");
        h.user("seat", "pt");
        h.member("owner", "seat", "revoked");
        expect(await readAccountLanguage(h.db, "seat")).toBe("pt");
    });

    it("answers Portuguese for an id it does not know", async () => {
        const h = harness();
        expect(await readAccountLanguage(h.db, "nobody")).toBe("pt");
    });

    it("answers Portuguese, and does not throw, before 0061 is applied", async () => {
        const h = harness({ withColumn: false });
        h.user("owner");
        expect(await readAccountLanguage(h.db, "owner")).toBe("pt");
    });
});
