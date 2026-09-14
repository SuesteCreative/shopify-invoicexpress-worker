import { describe, it, expect } from "vitest";
import { createAccountPost, deleteAccountPost, listAccountPosts, MAX_POST_CHARS } from "./account-posts";

/**
 * The wall replaced a single editable note for two reasons, and both are
 * properties worth pinning: concurrent writers must both survive, and a deleted
 * post must leave a trace.
 */
function harness() {
    const nodeSqlite = "node:sqlite";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require(nodeSqlite);
    const sqlite = new DatabaseSync(":memory:");

    sqlite.exec(`
        CREATE TABLE account_posts (
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL, author TEXT, body TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT, deleted_by TEXT
        );
        CREATE TABLE account_post_files (
            id TEXT PRIMARY KEY, post_id TEXT NOT NULL, user_id TEXT NOT NULL,
            pathname TEXT NOT NULL, filename TEXT NOT NULL, content_type TEXT NOT NULL,
            size_bytes INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            deleted_at TEXT, deleted_by TEXT
        );
        CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT);
        CREATE TABLE config_audit (
            id TEXT PRIMARY KEY, user_id TEXT, actor TEXT, scope TEXT, field TEXT,
            old_value TEXT, new_value TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO users (id, name, email) VALUES ('op_1', 'Pedro Porto', 'pedro@example.pt');
        -- Another company. Nothing below may reach it.
        INSERT INTO account_posts (id, user_id, author, body) VALUES ('other', 'user_b', 'op_1', 'não me toques');
    `);

    const db = {
        prepare(sql: string) {
            const stmt = sqlite.prepare(sql);
            let bound: unknown[] = [];
            const api = {
                bind(...args: unknown[]) { bound = args; return api; },
                async first() { return stmt.get(...bound) ?? null; },
                async all() { return { results: stmt.all(...bound) }; },
                async run() { const r = stmt.run(...bound); return { meta: { changes: Number(r.changes ?? 0) } }; },
            };
            return api;
        },
    } as any;

    const audits = () => sqlite.prepare("SELECT scope, field, old_value, new_value FROM config_audit").all() as any[];
    const raw = (id: string) => sqlite.prepare("SELECT * FROM account_posts WHERE id = ?").get(id) as any;

    return { db, audits, raw };
}

describe("the account wall", () => {
    it("posts, newest first, with who wrote it", async () => {
        const h = harness();
        await createAccountPost(h.db, { accountId: "user_a", author: "op_1", body: "primeiro" });
        await createAccountPost(h.db, { accountId: "user_a", author: "op_1", body: "segundo" });

        const posts = await listAccountPosts(h.db, "user_a");
        expect(posts.map((p) => p.body)).toEqual(["segundo", "primeiro"]);
        expect(posts[0].author_name).toBe("Pedro Porto");
    });

    // The whole reason this replaced one editable box: two writers, both land.
    it("keeps both of two posts written without reading each other", async () => {
        const h = harness();
        await Promise.all([
            createAccountPost(h.db, { accountId: "user_a", author: "op_1", body: "do primeiro" }),
            createAccountPost(h.db, { accountId: "user_a", author: "op_1", body: "do segundo" }),
        ]);

        const bodies = (await listAccountPosts(h.db, "user_a")).map((p) => p.body).sort();
        expect(bodies).toEqual(["do primeiro", "do segundo"]);
    });

    it("refuses an empty post rather than filing a blank one", async () => {
        const h = harness();
        expect(await createAccountPost(h.db, { accountId: "user_a", author: "op_1", body: "   " }))
            .toEqual({ error: "empty" });
        expect(await listAccountPosts(h.db, "user_a")).toHaveLength(0);
    });

    it("caps a very long post rather than failing the write", async () => {
        const h = harness();
        await createAccountPost(h.db, { accountId: "user_a", author: "op_1", body: "x".repeat(MAX_POST_CHARS + 500) });
        expect((await listAccountPosts(h.db, "user_a"))[0].body).toHaveLength(MAX_POST_CHARS);
    });

    // Deletion hides; it does not erase. This product built config_audit because
    // a blanked credential had left no trace of who blanked it.
    it("hides a deleted post but keeps the row and what it said", async () => {
        const h = harness();
        const created = await createAccountPost(h.db, { accountId: "user_a", author: "op_1", body: "enganei-me" });
        const id = (created as any).id;

        expect(await deleteAccountPost(h.db, { accountId: "user_a", actor: "op_1", postId: id })).toBe(true);
        expect(await listAccountPosts(h.db, "user_a")).toHaveLength(0);

        const row = h.raw(id);
        expect(row.body).toBe("enganei-me");
        expect(row.deleted_by).toBe("op_1");
        expect(h.audits().some((a) => a.field === "post_deleted" && a.old_value === "enganei-me")).toBe(true);
    });

    it("will not delete another company's post", async () => {
        const h = harness();
        expect(await deleteAccountPost(h.db, { accountId: "user_a", actor: "op_1", postId: "other" })).toBe(false);
        expect(h.raw("other").deleted_at).toBeFalsy();
    });

    it("never lists another company's wall", async () => {
        const h = harness();
        await createAccountPost(h.db, { accountId: "user_a", author: "op_1", body: "só do A" });
        expect((await listAccountPosts(h.db, "user_a")).map((p) => p.body)).toEqual(["só do A"]);
    });
});
