import { describe, it, expect } from "vitest";
import { readMerchantTimeline } from "./document-log";

/**
 * One client's whole document history, which is what the customer record shows.
 *
 * Two things can go wrong quietly here and both are checked against real SQL.
 * Reading another merchant's rows would put one company's sales on another
 * company's record — the worst outcome this table has. And the record files each
 * row under the connection its subscription pays for, so the pair has to come
 * back on the row; without it every sale lands in the "no connection" bucket and
 * the split silently stops meaning anything.
 */

async function withDb(fn: (env: any) => Promise<void>) {
    let DatabaseSync: any;
    try {
        // Specifier in a variable: this project typechecks against
        // @cloudflare/workers-types, which has no node:sqlite declarations, so a
        // literal import fails tsc even though the test runs under Node.
        const nodeSqlite = "node:sqlite";
        ({ DatabaseSync } = await import(nodeSqlite));
    } catch {
        console.warn("node:sqlite unavailable; skipping merchant timeline check");
        return;
    }

    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`CREATE TABLE document_events (
        id TEXT PRIMARY KEY, external_id TEXT NOT NULL, user_id TEXT, shopify_domain TEXT,
        source_kind TEXT, destination_kind TEXT, invoice_id TEXT,
        event TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'info',
        summary TEXT NOT NULL, detail_json TEXT, actor TEXT, created_at TEXT NOT NULL
    );`);

    const insert = sqlite.prepare(`INSERT INTO document_events
        (id, external_id, user_id, shopify_domain, source_kind, destination_kind, invoice_id,
         event, severity, summary, detail_json, actor, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const rows = [
        ["e1", "pi_3TqCuoAAA", "user_a", null, "stripe", "moloni", "inv_1", "created", "info", "Documento criado", null, "pipeline", "2026-09-10T10:00:00Z"],
        ["e2", "pi_3TqCuoAAA", "user_a", null, "stripe", "moloni", "inv_1", "finalized", "info", "Documento finalizado", null, "pipeline", "2026-09-10T10:00:05Z"],
        ["e3", "4799", "user_a", "2d0604-3.myshopify.com", null, null, "inv_2", "drift", "error", "Código de isenção diferente", '{"sent":"M05","stored":"M99"}', "sweep", "2026-09-11T09:00:00Z"],
        // Another merchant's row, at the same minute.
        ["e4", "pi_3TrIAOBBB", "user_b", null, "stripe", "invoicexpress", "inv_3", "created", "info", "Documento criado", null, "pipeline", "2026-09-11T09:00:00Z"],
    ];
    for (const r of rows) insert.run(...r);

    const env = {
        DB: {
            prepare(sql: string) {
                const stmt = sqlite.prepare(sql);
                let bound: unknown[] = [];
                const api = {
                    bind(...args: unknown[]) { bound = args; return api; },
                    async all() { return { results: stmt.all(...bound) }; },
                };
                return api;
            },
        },
    };

    await fn(env);
}

describe("readMerchantTimeline", () => {
    it("returns only this merchant's rows, newest first", async () => {
        await withDb(async (env) => {
            const rows = await readMerchantTimeline(env, { userId: "user_a" });
            expect(rows.map(r => r.id)).toEqual(["e3", "e2", "e1"]);
            expect(rows.some(r => r.external_id === "pi_3TrIAOBBB")).toBe(false);
        });
    });

    it("carries the pair, so the record can file each row under its connection", async () => {
        await withDb(async (env) => {
            const rows = await readMerchantTimeline(env, { userId: "user_a" });
            const stripe = rows.find(r => r.id === "e1")!;
            expect([stripe.source_kind, stripe.destination_kind]).toEqual(["stripe", "moloni"]);

            // A legacy Shopify row has no pair, only a shop — which the record
            // maps to shopify:invoicexpress, the only pair that path ever ran.
            const legacy = rows.find(r => r.id === "e3")!;
            expect([legacy.source_kind, legacy.destination_kind]).toEqual([null, null]);
            expect(legacy.shopify_domain).toBe("2d0604-3.myshopify.com");
        });
    });

    it("explains each event in words, like the per-sale timeline does", async () => {
        await withDb(async (env) => {
            const rows = await readMerchantTimeline(env, { userId: "user_a" });
            const drift = rows.find(r => r.id === "e3")!;
            expect(drift.severity).toBe("error");
            expect(drift.summary).toContain("isenção");
            expect(drift.label).toBeTruthy();
            expect(drift.detail).toEqual({ sent: "M05", stored: "M99" });
        });
    });

    it("caps what it will read back, however large the ask", async () => {
        await withDb(async (env) => {
            expect(await readMerchantTimeline(env, { userId: "user_a", limit: 10_000 })).toHaveLength(3);
            expect(await readMerchantTimeline(env, { userId: "user_a", limit: 1 })).toHaveLength(1);
        });
    });
});
