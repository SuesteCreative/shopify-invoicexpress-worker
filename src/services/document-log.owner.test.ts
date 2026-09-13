import { describe, it, expect } from "vitest";
import { logDocumentEvent } from "./document-log";

/**
 * A document event names its account even when the caller only knew the shop.
 *
 * The document-verify history run passed the user it read from processed_orders,
 * which the legacy Shopify handlers had left NULL, and wrote 4,471 events that no
 * account's record could reach — among them the only trace of eight documents
 * issued with the wrong exemption code.
 */

async function withDb(fn: (h: { env: any; row: (id: string) => any }) => Promise<void>) {
    let DatabaseSync: any;
    try {
        // Specifier in a variable: the worker typechecks against workers-types,
        // which has no node:sqlite declarations.
        const nodeSqlite = "node:sqlite";
        ({ DatabaseSync } = await import(nodeSqlite));
    } catch {
        console.warn("node:sqlite unavailable; skipping document-log owner check");
        return;
    }

    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
        CREATE TABLE document_events (
            id TEXT PRIMARY KEY, external_id TEXT NOT NULL, user_id TEXT, shopify_domain TEXT,
            source_kind TEXT, destination_kind TEXT, invoice_id TEXT,
            event TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'info',
            summary TEXT NOT NULL, detail_json TEXT, detail_truncated INTEGER DEFAULT 0,
            actor TEXT, dedup_key TEXT, created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_document_events_dedup ON document_events(dedup_key);
        CREATE TABLE integrations (id TEXT PRIMARY KEY, user_id TEXT, shopify_domain TEXT);
        INSERT INTO integrations VALUES ('i_1', 'user_owner', 'loja.myshopify.com');
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
    };

    await fn({
        env,
        row: (externalId: string) => sqlite.prepare("SELECT * FROM document_events WHERE external_id = ?").get(externalId),
    });
}

describe("logDocumentEvent — the account on the row", () => {
    it("files an event under the shop's owner when the caller passes no user", async () => {
        await withDb(async ({ env, row }) => {
            await logDocumentEvent(env, {
                externalId: "4800", event: "verified", summary: "Documento verificado",
                shopifyDomain: "loja.myshopify.com", invoiceId: "inv_1", actor: "cron:document-verify",
            });
            const r = row("4800");
            expect(r.user_id).toBe("user_owner");
            // Nothing else moved one column over.
            expect(r.shopify_domain).toBe("loja.myshopify.com");
            expect(r.invoice_id).toBe("inv_1");
            expect(r.event).toBe("verified");
            expect(r.actor).toBe("cron:document-verify");
        });
    });

    it("keeps the user the caller passed", async () => {
        await withDb(async ({ env, row }) => {
            await logDocumentEvent(env, {
                externalId: "4801", event: "verified", summary: "Documento verificado",
                userId: "user_explicit", shopifyDomain: "loja.myshopify.com",
            });
            expect(row("4801").user_id).toBe("user_explicit");
        });
    });

    it("leaves a shop with no integrations row unattributed, and still writes the event", async () => {
        await withDb(async ({ env, row }) => {
            await logDocumentEvent(env, {
                externalId: "4802", event: "verified", summary: "Documento verificado",
                shopifyDomain: "conta-apagada.myshopify.com",
            });
            const r = row("4802");
            expect(r).toBeTruthy();
            expect(r.user_id).toBeNull();
        });
    });
});
