import { describe, it, expect } from "vitest";
import { AppStorage } from "./storage";

/**
 * Walking a connection's processed orders in batches.
 *
 * A finalize run costs two subrequests per row before it writes anything (the
 * source's paid total, the destination's document), so an account with 657 rows
 * does not fit in one request. Batching it needs a cursor — and a cursor rather
 * than an OFFSET, because the phases that follow finalize DELETE rows, and an
 * offset silently skips a row for every deletion behind it.
 */

async function db(rows: Array<{ id: string; invoice: string; user?: string; source?: string; created?: string }>) {
  let DatabaseSync: any;
  try {
    const nodeSqlite = "node:sqlite";
    ({ DatabaseSync } = await import(nodeSqlite));
  } catch {
    return null;
  }
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE processed_orders (
      id TEXT PRIMARY KEY, invoice_id TEXT, created_at TEXT, shopify_domain TEXT,
      user_id TEXT, source_kind TEXT, destination_kind TEXT, hold_reason TEXT, routed_json TEXT
    );
  `);
  for (const r of rows) {
    sqlite.exec(`INSERT INTO processed_orders (id, invoice_id, created_at, user_id, source_kind)
                 VALUES ('${r.id}','${r.invoice}','${r.created ?? "2026-09-08T10:00:00Z"}','${r.user ?? "user_X"}','${r.source ?? "stripe"}')`);
  }
  const env: any = {
    DB: {
      prepare(sql: string) {
        const stmt = sqlite.prepare(sql);
        let args: any[] = [];
        const api = {
          bind(...a: any[]) { args = a; return api; },
          async all() { return { results: stmt.all(...args) }; },
          async run() { return { meta: { changes: stmt.run(...args).changes } }; },
          async first() { return stmt.get(...args) ?? null; },
        };
        return api;
      },
    },
  };
  return { env, sqlite, close: () => sqlite.close() };
}

const SEED = Array.from({ length: 10 }, (_, i) => ({ id: `pi_${i + 1}`, invoice: `${900 + i}` }));

describe("paging processed orders with a rowid cursor", () => {
  it("walks the whole connection in batches instead of re-reading the first page", async () => {
    const h = await db(SEED);
    if (!h) return;
    try {
      const storage = new AppStorage(h.env, undefined, "user_X");
      const seen: string[] = [];
      let cursor: number | null = null;
      for (let page = 0; page < 5; page++) {
        const rows = await storage.listProcessedInvoicesByUser("user_X", "stripe", 4, "asc", cursor);
        if (rows.length === 0) break;
        seen.push(...rows.map((r) => r.id));
        cursor = rows[rows.length - 1].rowid;
      }
      // Every row exactly once, in insertion order. Without the cursor this was
      // the first four ids repeated for ever.
      expect(seen).toEqual(SEED.map((r) => r.id));
    } finally { h.close(); }
  });

  it("keeps its place when rows behind the cursor are deleted", async () => {
    const h = await db(SEED);
    if (!h) return;
    try {
      const storage = new AppStorage(h.env, undefined, "user_X");
      const first = await storage.listProcessedInvoicesByUser("user_X", "stripe", 4, "asc", null);
      expect(first.map((r) => r.id)).toEqual(["pi_1", "pi_2", "pi_3", "pi_4"]);

      // Fase 3 deletes wrong drafts. An OFFSET of 4 would now skip pi_6.
      h.sqlite.exec("DELETE FROM processed_orders WHERE id IN ('pi_2','pi_3')");

      const second = await storage.listProcessedInvoicesByUser("user_X", "stripe", 4, "asc", first[first.length - 1].rowid);
      expect(second.map((r) => r.id)).toEqual(["pi_5", "pi_6", "pi_7", "pi_8"]);
    } finally { h.close(); }
  });

  it("does not leak another connection's rows into the page", async () => {
    const h = await db([
      ...SEED.slice(0, 3),
      { id: "ord_1", invoice: "800", source: "shopify" },
      { id: "pi_other", invoice: "801", user: "user_Y" },
    ]);
    if (!h) return;
    try {
      const storage = new AppStorage(h.env, undefined, "user_X");
      const rows = await storage.listProcessedInvoicesByUser("user_X", "stripe", 50, "asc", null);
      expect(rows.map((r) => r.id)).toEqual(["pi_1", "pi_2", "pi_3"]);
    } finally { h.close(); }
  });

  it("reads backwards from the cursor when the order is reversed", async () => {
    const h = await db(SEED);
    if (!h) return;
    try {
      const storage = new AppStorage(h.env, undefined, "user_X");
      const newest = await storage.listProcessedInvoicesByUser("user_X", "stripe", 3, "desc", null);
      expect(newest.map((r) => r.id)).toEqual(["pi_10", "pi_9", "pi_8"]);
      const next = await storage.listProcessedInvoicesByUser("user_X", "stripe", 3, "desc", newest[newest.length - 1].rowid);
      expect(next.map((r) => r.id)).toEqual(["pi_7", "pi_6", "pi_5"]);
    } finally { h.close(); }
  });
});
