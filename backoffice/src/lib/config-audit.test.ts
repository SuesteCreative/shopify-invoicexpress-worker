import { describe, it, expect } from "vitest";
import { auditValue, auditFieldDiff } from "./config-audit";

function harness() {
    const nodeSqlite = "node:sqlite";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require(nodeSqlite);
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`CREATE TABLE config_audit (
        id TEXT PRIMARY KEY, user_id TEXT, actor TEXT, scope TEXT, field TEXT,
        old_value TEXT, new_value TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );`);
    const db = {
        prepare(sql: string) {
            const stmt = sqlite.prepare(sql);
            let bound: unknown[] = [];
            const api = {
                bind(...args: unknown[]) { bound = args; return api; },
                async run() { stmt.run(...bound); return { meta: { changes: 1 } }; },
            };
            return api;
        },
    } as any;
    return { db, all: () => sqlite.prepare("SELECT * FROM config_audit ORDER BY field").all() as any[] };
}

describe("auditValue", () => {
    it("never stores a credential, only whether there was one", () => {
        expect(auditValue("ix_api_key", "abcdef0123456789")).toBe("«definido, 16 caracteres»");
        expect(auditValue("ix_api_key", "")).toBe("«vazio»");
        expect(auditValue("ix_api_key", null)).toBe("«vazio»");
        expect(auditValue("shopify_token", "shpat_secret")).not.toContain("shpat");
    });

    it("stores ordinary configuration as itself", () => {
        expect(auditValue("ix_account_name", "whmservicesunipes")).toBe("whmservicesunipes");
        expect(auditValue("ix_sequence_name", null)).toBeNull();
    });
});

describe("auditFieldDiff", () => {
    const ctx = { userId: "user_a", actor: "user_admin", scope: "integrations" };

    it("records the blanking that nobody could explain", async () => {
        const h = harness();
        const changed = await auditFieldDiff(h.db, ctx,
            { ix_account_name: "farracemotaunipes", ix_api_key: "k".repeat(40) },
            { ix_account_name: null, ix_api_key: null });

        expect(changed.sort()).toEqual(["ix_account_name", "ix_api_key"]);
        const key = h.all().find(r => r.field === "ix_api_key");
        expect(key.old_value).toBe("«definido, 40 caracteres»");
        expect(key.new_value).toBe("«vazio»");
        expect(key.actor).toBe("user_admin");
    });

    it("records a rotated key, which two presence markers alone would hide", async () => {
        const h = harness();
        const changed = await auditFieldDiff(h.db, ctx,
            { ix_api_key: "a".repeat(40) },
            { ix_api_key: "b".repeat(40) });
        expect(changed).toEqual(["ix_api_key"]);
    });

    it("writes nothing for a save that changed nothing", async () => {
        const h = harness();
        const changed = await auditFieldDiff(h.db, ctx,
            { ix_account_name: "conta", ix_api_key: "k", auto_finalize: 0 },
            { ix_account_name: "conta", ix_api_key: "k", auto_finalize: 0 });
        expect(changed).toEqual([]);
        expect(h.all()).toHaveLength(0);
    });

    it("treats null and empty string as the same absence", async () => {
        const h = harness();
        expect(await auditFieldDiff(h.db, ctx, { ix_sequence_name: null }, { ix_sequence_name: "" })).toEqual([]);
    });

    it("logs a first-time save as a change from nothing", async () => {
        const h = harness();
        const changed = await auditFieldDiff(h.db, ctx, null, { ix_account_name: "bestisafil" });
        expect(changed).toEqual(["ix_account_name"]);
        expect(h.all()[0].old_value).toBeNull();
    });
});
