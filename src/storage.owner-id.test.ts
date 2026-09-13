import { describe, it, expect } from "vitest";
import { AppStorage } from "./storage";

/**
 * Every row a Shopify handler writes names its account.
 *
 * The handlers build AppStorage from the shop domain alone and never call
 * loadConfig on that instance, so `userId` stayed null and a month of Shopify
 * documents was written with no account: invisible to every screen that reads by
 * account, and counted as "0 documents" by the guard in front of deleting the
 * legacy row. The owner is now resolved inside each statement.
 *
 * The SQL runs for real (node:sqlite): each change adds a positional placeholder,
 * and a shifted bind would quietly write the shop into user_id or the date into
 * the wrong column — so every column is checked, not only user_id.
 */

async function withDb(fn: (h: { env: any; one: (sql: string, ...a: unknown[]) => any }) => Promise<void>) {
    let DatabaseSync: any;
    try {
        const nodeSqlite = "node:sqlite";
        ({ DatabaseSync } = await import(nodeSqlite));
    } catch {
        console.warn("node:sqlite unavailable; skipping storage owner check");
        return;
    }
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
        CREATE TABLE integrations (id TEXT PRIMARY KEY, user_id TEXT, shopify_domain TEXT);
        INSERT INTO integrations VALUES ('i_1', 'user_X', 'loja.myshopify.com');
        CREATE TABLE processed_orders (
            id TEXT PRIMARY KEY, invoice_id TEXT, shopify_domain TEXT, user_id TEXT, created_at TEXT,
            source_kind TEXT, destination_kind TEXT, hold_reason TEXT, routed_json TEXT
        );
        CREATE TABLE logs (
            id TEXT PRIMARY KEY, shopify_domain TEXT, user_id TEXT, topic TEXT,
            payload TEXT, response TEXT, status INTEGER
        );
        CREATE TABLE dev_jobs (
            id TEXT PRIMARY KEY, shopify_domain TEXT, user_id TEXT, type TEXT, params TEXT, status TEXT,
            triggered_by TEXT, reason TEXT, started_at TEXT, source_kind TEXT, destination_kind TEXT
        );
        CREATE TABLE webhook_info (
            webhook_id TEXT PRIMARY KEY, topic TEXT, state TEXT, created_at TEXT, shopify_domain TEXT, user_id TEXT
        );
    `);
    const env = {
        DB: {
            prepare(sql: string) {
                const stmt = sqlite.prepare(sql);
                let bound: unknown[] = [];
                const api = {
                    bind(...args: unknown[]) { bound = args; return api; },
                    async run() { return { meta: { changes: Number(stmt.run(...bound).changes ?? 0) } }; },
                    async first() { return stmt.get(...bound) ?? null; },
                    async all() { return { results: stmt.all(...bound) }; },
                };
                return api;
            },
        },
        INVOICE_KV: { async get() { return null; }, async put() { }, async delete() { } },
    };
    await fn({ env, one: (sql, ...a) => sqlite.prepare(sql).get(...a) });
}

/** Everything a legacy Shopify handler writes through one instance. */
async function writeAll(storage: AppStorage, tag: string) {
    await storage.saveProcessedInvoice(`order_${tag}`, `inv_${tag}`);
    await storage.saveLog({ shopify_domain: (storage as any).shopDomain, topic: "orders/paid", payload: { id: tag }, response: { ok: true }, status: 200 });
    await storage.startDevJob({ id: `job_${tag}`, type: "reemit", params: { order: tag }, triggered_by: "cron", reason: "teste" });
    await storage.markWebhookAsProcessing(`wh_${tag}`, "orders/paid");
    await storage.markWebhookAsProcessed(`wh_${tag}`, "orders/paid", "success");
}

describe("AppStorage writes name the shop's owner", () => {
    it("built from the shop alone, every row gets the owner — and every other column stays in place", async () => {
        await withDb(async ({ env, one }) => {
            await writeAll(new AppStorage(env, "loja.myshopify.com"), "a");

            const po = one("SELECT * FROM processed_orders WHERE id = 'order_a'");
            expect(po).toMatchObject({
                invoice_id: "inv_a", shopify_domain: "loja.myshopify.com", user_id: "user_X",
                source_kind: "shopify", destination_kind: "invoicexpress", hold_reason: null, routed_json: null,
            });
            expect(po.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

            const log = one("SELECT * FROM logs WHERE topic = 'orders/paid'");
            expect(log).toMatchObject({ shopify_domain: "loja.myshopify.com", user_id: "user_X", status: 200 });
            expect(JSON.parse(log.payload)).toEqual({ id: "a" });

            const job = one("SELECT * FROM dev_jobs WHERE id = 'job_a'");
            expect(job).toMatchObject({
                shopify_domain: "loja.myshopify.com", user_id: "user_X", type: "reemit",
                status: "running", triggered_by: "cron", reason: "teste",
            });
            expect(JSON.parse(job.params)).toEqual({ order: "a" });

            // The handler's "success" replaces the "processing" row: it used to put
            // the NULL back over the user the queue consumer had written.
            const wh = one("SELECT * FROM webhook_info WHERE webhook_id = 'wh_a'");
            expect(wh).toMatchObject({ topic: "orders/paid", state: "success", shopify_domain: "loja.myshopify.com", user_id: "user_X" });
        });
    });

    it("keeps an id the instance already knows", async () => {
        await withDb(async ({ env, one }) => {
            await writeAll(new AppStorage(env, "loja.myshopify.com", "user_Y"), "b");
            expect(one("SELECT user_id FROM processed_orders WHERE id = 'order_b'").user_id).toBe("user_Y");
            expect(one("SELECT user_id FROM webhook_info WHERE webhook_id = 'wh_b'").user_id).toBe("user_Y");
        });
    });

    it("leaves a shop with no integrations row unattributed — and still writes the idempotency row", async () => {
        await withDb(async ({ env, one }) => {
            await writeAll(new AppStorage(env, "conta-apagada.myshopify.com"), "c");
            const po = one("SELECT * FROM processed_orders WHERE id = 'order_c'");
            expect(po).toBeTruthy();
            expect(po.user_id).toBeNull();
        });
    });

    it("with neither shop nor account, writes the row with no owner rather than failing", async () => {
        await withDb(async ({ env, one }) => {
            const storage = new AppStorage(env);
            await storage.markWebhookAsProcessed("evt_1", "stripe/invoice.paid", "failed");
            expect(one("SELECT * FROM webhook_info WHERE webhook_id = 'evt_1'")).toMatchObject({ state: "failed", user_id: null });
        });
    });
});
