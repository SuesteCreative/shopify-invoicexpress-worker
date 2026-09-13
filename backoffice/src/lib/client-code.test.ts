import { describe, it, expect, vi } from "vitest";
import {
    CLIENT_CODE_RE, newClientCode, normalizeClientCode,
    upsertUserRow, ensureClientCode, resolveClientCode, lookupRetiredCode,
} from "./client-code";

/**
 * The customer code, checked where it can actually go wrong.
 *
 * Two failures this guards against, both silent. A code that is not unique makes
 * two companies answer to one number, and the only thing standing between the
 * fleet and that is a UNIQUE index plus a retry — so the index and the retry run
 * for real here, not in prose. And a code nobody can type back is a code that
 * stops being used: `normalizeClientCode` is what makes a dictated code work,
 * and its edge cases are exactly the ones an operator produces by hand.
 *
 * The SQL runs against node:sqlite, like billing-identity.test.ts, so a column
 * that does not exist cannot reach production.
 */

function harness(opts: { withColumn?: boolean } = {}) {
    const withColumn = opts.withColumn !== false;
    // Named indirectly, as the other SQL tests here do, so the bundler does not
    // try to resolve a node: builtin for the edge runtime.
    const nodeSqlite = "node:sqlite";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require(nodeSqlite);
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
        CREATE TABLE users (
            id TEXT PRIMARY KEY, email TEXT, name TEXT,
            last_login TEXT${withColumn ? ", client_code TEXT" : ""}
        );
        CREATE TABLE account_members (
            id TEXT PRIMARY KEY, account_id TEXT, member_user_id TEXT,
            status TEXT, accepted_at TEXT
        );
    `);
    if (withColumn) {
        sqlite.exec("CREATE UNIQUE INDEX idx_users_client_code ON users(client_code);");
        sqlite.exec(`CREATE TABLE client_codes (
            code TEXT PRIMARY KEY, user_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );`);
    }

    const db = {
        prepare(sql: string) {
            const stmt = sqlite.prepare(sql);
            let bound: unknown[] = [];
            const api = {
                bind(...args: unknown[]) { bound = args; return api; },
                async run() {
                    const r = stmt.run(...bound);
                    return { meta: { changes: Number(r.changes ?? 0) } };
                },
                async first() { return stmt.get(...bound) ?? null; },
            };
            return api;
        },
    } as any;

    return {
        db,
        sqlite,
        rows: () => sqlite.prepare("SELECT * FROM users ORDER BY id").all() as any[],
        row: (id: string) => sqlite.prepare("SELECT * FROM users WHERE id = ?").get(id) as any,
        ledger: () => sqlite.prepare("SELECT * FROM client_codes ORDER BY code").all() as any[],
    };
}

describe("the code's shape", () => {
    it("is six hex characters behind RIO-, every time", () => {
        for (let i = 0; i < 200; i++) expect(newClientCode()).toMatch(CLIENT_CODE_RE);
    });

    it("never contains a character that can be misread for another", () => {
        // No O against 0, no I or l against 1: that is the whole point of hex.
        for (let i = 0; i < 200; i++) expect(newClientCode().slice(4)).not.toMatch(/[OIL]/);
    });
});

describe("normalizeClientCode", () => {
    it("accepts the code the way a person types it back", () => {
        expect(normalizeClientCode("RIO-1A2B3C")).toBe("RIO-1A2B3C");
        expect(normalizeClientCode("rio-1a2b3c")).toBe("RIO-1A2B3C");
        expect(normalizeClientCode("RIO 1a2b3c")).toBe("RIO-1A2B3C");
        expect(normalizeClientCode("rio1a2b3c")).toBe("RIO-1A2B3C");
        expect(normalizeClientCode("  1A2B3C ")).toBe("RIO-1A2B3C");
        expect(normalizeClientCode("RIO_1A2B3C")).toBe("RIO-1A2B3C");
    });

    it("refuses anything that is not a code", () => {
        expect(normalizeClientCode("RIO-1A2B3G")).toBeNull();   // G is not hex
        expect(normalizeClientCode("RIO-12345")).toBeNull();    // five characters
        expect(normalizeClientCode("RIO-1A2B3C4")).toBeNull();  // seven
        expect(normalizeClientCode("user_3DtDCQn0mIe7T6Ynlx75wWOfUPn")).toBeNull();
        expect(normalizeClientCode("")).toBeNull();
        expect(normalizeClientCode(null)).toBeNull();
    });
});

describe("upsertUserRow", () => {
    it("gives a new account a code", async () => {
        const h = harness();
        await upsertUserRow(h.db, { id: "user_a", email: "a@x.pt", name: "A Lda" });
        expect(h.row("user_a").client_code).toMatch(CLIENT_CODE_RE);
    });

    it("keeps the code across a login, and still refreshes name and email", async () => {
        const h = harness();
        await upsertUserRow(h.db, { id: "user_a", email: "a@x.pt", name: "A Lda" });
        const first = h.row("user_a").client_code;

        await upsertUserRow(h.db, { id: "user_a", email: "novo@x.pt", name: "A Unipessoal Lda" });
        const after = h.row("user_a");

        expect(after.client_code).toBe(first);
        expect(after.email).toBe("novo@x.pt");
        expect(after.name).toBe("A Unipessoal Lda");
    });

    it("heals a row that arrived without one", async () => {
        const h = harness();
        h.sqlite.exec("INSERT INTO users (id, email, name) VALUES ('user_old', 'old@x.pt', 'Old');");
        await upsertUserRow(h.db, { id: "user_old", email: "old@x.pt", name: "Old" });
        expect(h.row("user_old").client_code).toMatch(CLIENT_CODE_RE);
    });

    it("still signs people up when the migration has not been applied yet", async () => {
        const h = harness({ withColumn: false });
        await upsertUserRow(h.db, { id: "user_a", email: "a@x.pt", name: "A Lda" });
        expect(h.row("user_a").email).toBe("a@x.pt");
    });

    it("enters every code it hands out in the ledger", async () => {
        const h = harness();
        await upsertUserRow(h.db, { id: "user_a", email: "a@x.pt", name: "A Lda" });
        expect(h.ledger()).toEqual([
            expect.objectContaining({ code: h.row("user_a").client_code, user_id: "user_a" }),
        ]);
    });

    it("burns no code on a login, only on a new account", async () => {
        const h = harness();
        await upsertUserRow(h.db, { id: "user_a", email: "a@x.pt", name: "A Lda" });
        await upsertUserRow(h.db, { id: "user_a", email: "a@x.pt", name: "A Lda" });
        await upsertUserRow(h.db, { id: "user_a", email: "a@x.pt", name: "A Lda" });
        expect(h.ledger()).toHaveLength(1);
    });

    it("never hands a deleted account's number to anybody else", async () => {
        const h = harness();

        // Aim the mint: the same three bytes twice, then different ones. Without
        // this the odds of the collision under test are one in 16.7 million.
        const bytes = [[0xAB, 0xCD, 0xEF], [0xAB, 0xCD, 0xEF], [0x12, 0x34, 0x56]];
        let call = 0;
        const spy = vi.spyOn(globalThis.crypto, "getRandomValues")
            .mockImplementation((arr: any) => { arr.set(bytes[Math.min(call++, bytes.length - 1)]); return arr; });

        try {
            await upsertUserRow(h.db, { id: "user_gone", email: "g@x.pt", name: "Gone Lda" });
            expect(h.row("user_gone").client_code).toBe("RIO-ABCDEF");

            // What user.deleted does: the account row goes, its documents stay
            // (processed_orders, document_events), and the ledger keeps the
            // number out of circulation.
            h.sqlite.exec("DELETE FROM users WHERE id = 'user_gone';");

            await upsertUserRow(h.db, { id: "user_new", email: "n@x.pt", name: "New Lda" });
        } finally { spy.mockRestore(); }

        // The retired number was offered again and refused; the new account got
        // a different one, and both stay burnt.
        expect(h.row("user_new").client_code).toBe("RIO-123456");
        expect(h.ledger().map((r: any) => r.code)).toEqual(["RIO-123456", "RIO-ABCDEF"]);
    });

    it("tries another code when the unique index refuses one", async () => {
        const h = harness();
        let attempts = 0;
        const flaky = {
            prepare(sql: string) {
                const inner = h.db.prepare(sql);
                return {
                    bind(...args: unknown[]) { inner.bind(...args); return this; },
                    async run() {
                        if (sql.includes("INSERT INTO users") && attempts++ === 0) {
                            throw new Error("UNIQUE constraint failed: users.client_code");
                        }
                        return inner.run();
                    },
                    first: () => inner.first(),
                };
            },
        } as any;

        await upsertUserRow(flaky, { id: "user_a", email: "a@x.pt", name: "A Lda" });
        expect(attempts).toBe(2);
        expect(h.row("user_a").client_code).toMatch(CLIENT_CODE_RE);
        // The refused code stays burnt: a number that was offered once is never
        // offered again, even to the account it failed on.
        expect(h.ledger()).toHaveLength(2);
    });
});

describe("ensureClientCode", () => {
    it("mints one for a row that has none", async () => {
        const h = harness();
        h.sqlite.exec("INSERT INTO users (id) VALUES ('user_a');");
        const code = await ensureClientCode(h.db, "user_a");
        expect(code).toMatch(CLIENT_CODE_RE);
        expect(h.row("user_a").client_code).toBe(code);
    });

    it("returns the code a row already has, unchanged", async () => {
        const h = harness();
        h.sqlite.exec("INSERT INTO users (id, client_code) VALUES ('user_a', 'RIO-1A2B3C');");
        expect(await ensureClientCode(h.db, "user_a")).toBe("RIO-1A2B3C");
    });

    it("answers null rather than throwing for an account that is gone", async () => {
        const h = harness();
        expect(await ensureClientCode(h.db, "user_missing")).toBeNull();
    });

    it("answers null rather than taking the page down before the migration", async () => {
        const h = harness({ withColumn: false });
        h.sqlite.exec("INSERT INTO users (id) VALUES ('user_a');");
        expect(await ensureClientCode(h.db, "user_a")).toBeNull();
    });
});

describe("resolveClientCode", () => {
    async function seeded() {
        const h = harness();
        h.sqlite.exec(`
            INSERT INTO users (id, client_code) VALUES
                ('user_owner', 'RIO-1A2B3C'),
                ('user_member', 'RIO-D4E5F6');
            INSERT INTO account_members (id, account_id, member_user_id, status, accepted_at)
            VALUES ('m1', 'user_owner', 'user_member', 'active', '2026-09-01T00:00:00Z');
        `);
        return h;
    }

    it("finds the account by its code, however it was typed", async () => {
        const h = await seeded();
        expect(await resolveClientCode(h.db, "rio 1a2b3c")).toEqual({ accountId: "user_owner", memberOf: null });
    });

    it("still accepts a raw Clerk id, so existing links keep working", async () => {
        const h = await seeded();
        expect(await resolveClientCode(h.db, "user_owner")).toEqual({ accountId: "user_owner", memberOf: null });
    });

    it("sends a member's code to the account they work inside", async () => {
        const h = await seeded();
        expect(await resolveClientCode(h.db, "RIO-D4E5F6")).toEqual({
            accountId: "user_owner", memberOf: "user_member",
        });
    });

    it("answers null for a code nobody holds", async () => {
        const h = await seeded();
        expect(await resolveClientCode(h.db, "RIO-FFFFFF")).toBeNull();
        expect(await resolveClientCode(h.db, "não é um código")).toBeNull();
    });
});

describe("lookupRetiredCode", () => {
    it("tells a deleted account's number apart from a typo", async () => {
        const h = harness();
        await upsertUserRow(h.db, { id: "user_gone", email: "g@x.pt", name: "Gone Lda" });
        const code = h.row("user_gone").client_code;
        h.sqlite.exec("DELETE FROM users WHERE id = 'user_gone';");

        expect(await resolveClientCode(h.db, code)).toBeNull();
        expect(await lookupRetiredCode(h.db, code)).toMatchObject({ code, user_id: "user_gone" });
        expect(await lookupRetiredCode(h.db, "RIO-FFFFFF")).toBeNull();
    });
});

describe("the migration's backfill", () => {
    it("gives 500 accounts 500 different codes, and the index proves it", () => {
        const h = harness({ withColumn: false });
        h.sqlite.exec("ALTER TABLE users ADD COLUMN client_code TEXT;");
        for (let i = 0; i < 500; i++) h.sqlite.exec(`INSERT INTO users (id) VALUES ('user_${i}');`);

        // The exact statement from migrations/0058_client_code.sql, in the same
        // order: backfill first, index second, so a collision fails loudly here
        // instead of aborting in silence.
        h.sqlite.exec("UPDATE users SET client_code = 'RIO-' || hex(randomblob(3)) WHERE client_code IS NULL;");
        h.sqlite.exec("CREATE UNIQUE INDEX idx_users_client_code ON users(client_code);");

        const codes = h.rows().map(r => r.client_code);
        expect(codes).toHaveLength(500);
        expect(new Set(codes).size).toBe(500);
        for (const c of codes) expect(c).toMatch(CLIENT_CODE_RE);
    });

    it("produces the same shape the runtime does", () => {
        const h = harness({ withColumn: false });
        const sql: any = h.sqlite.prepare("SELECT 'RIO-' || hex(randomblob(3)) AS code").get();
        expect(sql.code).toMatch(CLIENT_CODE_RE);
        expect(newClientCode()).toMatch(CLIENT_CODE_RE);
    });
});
