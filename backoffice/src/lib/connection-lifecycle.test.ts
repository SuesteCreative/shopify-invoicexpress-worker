import { describe, it, expect } from "vitest";
import {
    deleteConnection, resetConnection, setConnectionStatus,
    deleteLegacyIntegration, resetLegacyIntegration, setLegacyPaused,
} from "./connection-lifecycle";

/**
 * These three functions are the destructive end of the admin console, and the
 * property that matters most is the one about what they must NOT touch.
 *
 * `processed_orders` is the record of documents actually issued. Deleting a
 * connection alongside its history is what would make a re-setup re-invoice a
 * year of sales, so the test that earns its place here is the one asserting
 * those rows survive.
 *
 * Stripe deauthorisation is not exercised: with no STRIPE_CONNECT_CLIENT_ID in
 * the environment, revokeStripeConnect returns null before it reaches fetch,
 * which is exactly the path a non-Connect connection takes anyway.
 */

function harness() {
    const nodeSqlite = "node:sqlite";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require(nodeSqlite);
    const sqlite = new DatabaseSync(":memory:");

    sqlite.exec(`
        CREATE TABLE connections (
            id TEXT PRIMARY KEY, user_id TEXT, source_kind TEXT, destination_kind TEXT,
            source_config_json TEXT, destination_config_json TEXT, behavior_json TEXT,
            status TEXT, created_at TEXT, updated_at TEXT,
            oauth_state TEXT, oauth_state_expires_at TEXT, last_token_refresh_at TEXT
        );
        CREATE TABLE tag_routing_rules (id TEXT PRIMARY KEY, user_id TEXT, source_kind TEXT, destination_kind TEXT);
        CREATE TABLE product_mappings (id TEXT PRIMARY KEY, user_id TEXT, source_kind TEXT, destination_kind TEXT);
        CREATE TABLE processed_orders (id TEXT PRIMARY KEY, user_id TEXT, source_kind TEXT, destination_kind TEXT, invoice_id TEXT);

        INSERT INTO connections (id, user_id, source_kind, destination_kind, source_config_json, destination_config_json, behavior_json, status, created_at, updated_at)
        VALUES ('c1', 'user_a', 'stripe', 'moloni', '{"api_key":"sk_live_x"}', '{"company":"1"}', '{"auto_finalize":1}', 'active', '2026-01-01', '2026-01-01');

        INSERT INTO tag_routing_rules (id, user_id, source_kind, destination_kind) VALUES ('t1', 'user_a', 'stripe', 'moloni');
        INSERT INTO product_mappings   (id, user_id, source_kind, destination_kind) VALUES ('p1', 'user_a', 'stripe', 'moloni');
        INSERT INTO processed_orders   (id, user_id, source_kind, destination_kind, invoice_id) VALUES ('o1', 'user_a', 'stripe', 'moloni', 'inv_1');

        -- A second account on the same pair. Nothing below may reach it.
        INSERT INTO connections (id, user_id, source_kind, destination_kind, status, created_at, updated_at)
        VALUES ('c2', 'user_b', 'stripe', 'moloni', 'active', '2026-01-01', '2026-01-01');
        INSERT INTO tag_routing_rules (id, user_id, source_kind, destination_kind) VALUES ('t2', 'user_b', 'stripe', 'moloni');
    `);

    /** The slice of the D1 surface these functions use. */
    const db = {
        prepare(sql: string) {
            const stmt = sqlite.prepare(sql);
            let bound: unknown[] = [];
            const api = {
                bind(...args: unknown[]) { bound = args; return api; },
                async first() { return stmt.get(...bound) ?? null; },
                async run() {
                    const r = stmt.run(...bound);
                    return { meta: { changes: Number(r.changes ?? 0) } };
                },
            };
            return api;
        },
    } as any;

    const count = (table: string, where = "1=1") =>
        Number((sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as any).n);
    const row = (id: string) => sqlite.prepare("SELECT * FROM connections WHERE id = ?").get(id) as any;

    return { db, count, row };
}

describe("deleteConnection", () => {
    it("takes the connection and the rules keyed to its pair", async () => {
        const h = harness();
        const res = await deleteConnection(h.db, "user_a", "stripe", "moloni");

        expect(res.ok).toBe(true);
        expect(h.count("connections", "id = 'c1'")).toBe(0);
        expect(h.count("tag_routing_rules", "user_id = 'user_a'")).toBe(0);
        expect(h.count("product_mappings", "user_id = 'user_a'")).toBe(0);
    });

    it("never touches the documents already issued", async () => {
        const h = harness();
        await deleteConnection(h.db, "user_a", "stripe", "moloni");
        // The whole reason a re-setup does not re-invoice a year of sales.
        expect(h.count("processed_orders")).toBe(1);
    });

    it("leaves another account on the same pair alone", async () => {
        const h = harness();
        await deleteConnection(h.db, "user_a", "stripe", "moloni");
        expect(h.count("connections", "id = 'c2'")).toBe(1);
        expect(h.count("tag_routing_rules", "user_id = 'user_b'")).toBe(1);
    });

    it("says so rather than failing when there is nothing to delete", async () => {
        const h = harness();
        const res = await deleteConnection(h.db, "user_zzz", "stripe", "moloni");
        expect(res).toMatchObject({ ok: true, already_gone: true });
    });
});

describe("resetConnection", () => {
    it("keeps the row and empties it back to draft", async () => {
        const h = harness();
        await resetConnection(h.db, "user_a", "stripe", "moloni");

        const r = h.row("c1");
        expect(r).toBeTruthy();
        expect(r.status).toBe("draft");
        expect(r.source_config_json).toBeNull();
        expect(r.destination_config_json).toBeNull();
        expect(r.behavior_json).toBeNull();
    });

    it("clears the routing too, so a fresh setup cannot inherit the old one's rules", async () => {
        const h = harness();
        await resetConnection(h.db, "user_a", "stripe", "moloni");
        expect(h.count("tag_routing_rules", "user_id = 'user_a'")).toBe(0);
        expect(h.count("product_mappings", "user_id = 'user_a'")).toBe(0);
    });

    it("keeps the documents, exactly as delete does", async () => {
        const h = harness();
        await resetConnection(h.db, "user_a", "stripe", "moloni");
        expect(h.count("processed_orders")).toBe(1);
    });
});

/**
 * The legacy pipe is columns on the account's `integrations` row, not a row of
 * its own — and that row also carries the account's fiscal settings. Which of
 * those two survives is the entire difference between reset and delete, so the
 * fixture below holds both kinds of column.
 */
function legacyDb(opts: { documents?: number } = {}) {
    const nodeSqlite = "node:sqlite";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require(nodeSqlite);
    const sqlite = new DatabaseSync(":memory:");

    sqlite.exec(`
        CREATE TABLE integrations (
            id TEXT PRIMARY KEY, user_id TEXT,
            shopify_domain TEXT, shopify_token TEXT, shopify_webhook_secret TEXT,
            ix_account_name TEXT, ix_api_key TEXT,
            shopify_authorized INTEGER DEFAULT 0, ix_authorized INTEGER DEFAULT 0,
            webhooks_active INTEGER DEFAULT 0,
            shopify_error TEXT, ix_error TEXT,
            is_paused INTEGER DEFAULT 0,
            -- account configuration, which a reset must never touch
            vat_included INTEGER DEFAULT 1, ix_exemption_reason TEXT, auto_finalize INTEGER DEFAULT 1,
            updated_at TEXT
        );
        CREATE TABLE processed_orders (id TEXT PRIMARY KEY, user_id TEXT, source_kind TEXT, invoice_id TEXT);

        INSERT INTO integrations
          (id, user_id, shopify_domain, shopify_token, ix_account_name, ix_api_key,
           shopify_authorized, ix_authorized, vat_included, ix_exemption_reason)
        VALUES ('i1', 'user_a', 'shop.myshopify.com', 'shpat_x', 'conta-ix', 'key_x', 1, 1, 1, 'M10');
    `);

    for (let i = 0; i < (opts.documents ?? 0); i++) {
        sqlite.exec(`INSERT INTO processed_orders (id, user_id, source_kind, invoice_id) VALUES ('o${i}', 'user_a', 'shopify', 'inv_${i}');`);
    }

    const db = {
        prepare(sql: string) {
            const stmt = sqlite.prepare(sql);
            let bound: unknown[] = [];
            const api = {
                bind(...args: unknown[]) { bound = args; return api; },
                async first() { return stmt.get(...bound) ?? null; },
                async run() {
                    const r = stmt.run(...bound);
                    return { meta: { changes: Number(r.changes ?? 0) } };
                },
            };
            return api;
        },
    } as any;

    return {
        db,
        integration: (uid: string) => sqlite.prepare("SELECT * FROM integrations WHERE user_id = ?").get(uid) as any,
        countOrders: () => Number((sqlite.prepare("SELECT COUNT(*) AS n FROM processed_orders").get() as any).n),
    };
}

describe("the legacy Shopify pipe", () => {
    it("reset clears the credentials and keeps every fiscal setting", async () => {
        const h = legacyDb();
        await resetLegacyIntegration(h.db, "user_a");

        const r = h.integration("user_a");
        expect(r.shopify_domain).toBeNull();
        expect(r.ix_api_key).toBeNull();
        expect(Number(r.shopify_authorized)).toBe(0);
        // The part that must survive: this is the account's tax configuration,
        // not the integration's credentials.
        expect(Number(r.vat_included)).toBe(1);
        expect(r.ix_exemption_reason).toBe("M10");
    });

    it("delete refuses while documents exist, and says how many", async () => {
        const h = legacyDb({ documents: 3 });
        const res: any = await deleteLegacyIntegration(h.db, "user_a");

        expect(res.ok).toBe(false);
        expect(res.requires_force).toBe(true);
        expect(res.impact.documents).toBe(3);
        expect(h.integration("user_a")).toBeTruthy();
    });

    it("delete goes ahead on a row nobody ever configured", async () => {
        const h = legacyDb({ documents: 0 });
        const res: any = await deleteLegacyIntegration(h.db, "user_a");
        expect(res.ok).toBe(true);
        expect(h.integration("user_a")).toBeUndefined();
    });

    it("force deletes the configuration and still keeps the documents", async () => {
        const h = legacyDb({ documents: 3 });
        const res: any = await deleteLegacyIntegration(h.db, "user_a", true);
        expect(res.ok).toBe(true);
        expect(h.integration("user_a")).toBeUndefined();
        expect(h.countOrders()).toBe(3);
    });

    it("pauses and resumes with the flag the worker's gate reads", async () => {
        const h = legacyDb();
        await setLegacyPaused(h.db, "user_a", true);
        expect(Number(h.integration("user_a").is_paused)).toBe(1);
        await setLegacyPaused(h.db, "user_a", false);
        expect(Number(h.integration("user_a").is_paused)).toBe(0);
    });
});

describe("setConnectionStatus", () => {
    it("pauses and resumes the right row", async () => {
        const h = harness();
        await setConnectionStatus(h.db, "user_a", "stripe", "moloni", "paused");
        expect(h.row("c1").status).toBe("paused");
        expect(h.row("c2").status).toBe("active");

        await setConnectionStatus(h.db, "user_a", "stripe", "moloni", "active");
        expect(h.row("c1").status).toBe("active");
    });

    it("reports a miss instead of pretending it changed something", async () => {
        const h = harness();
        const res = await setConnectionStatus(h.db, "user_zzz", "stripe", "moloni", "paused");
        expect(res).toMatchObject({ ok: true, already_gone: true });
    });
});
