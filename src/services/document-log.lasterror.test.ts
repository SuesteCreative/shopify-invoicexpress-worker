import { describe, it, expect } from "vitest";
import { lookupLastEmissionError } from "./document-log";

/**
 * The lookup that decides whether an alarm tells the truth.
 *
 * When this returns null the dead-letter consumer reports a transport failure.
 * On 2026-09-14 InvoiceXpress refused eleven credit notes in writing, every
 * refusal landed in `logs`, and this returned null for all of them — so a day
 * was spent looking for a network problem that never existed.
 *
 * Two filters caused it, and the real rows are reproduced here exactly:
 *   - the refund path calls saveLog with an EMPTY payload, so requiring the
 *     order id to appear there could never match;
 *   - the phrase was `IX create failed`, which nothing writes. The real text is
 *     "InvoiceXpress finalize failed" / "InvoiceXpress credit create failed".
 */

async function withLogs(
  rows: Array<{ shopify_domain: string; payload: string; response: string; status: number; created_at: string }>,
  fn: (env: any) => Promise<void>,
) {
  let DatabaseSync: any;
  try {
    const nodeSqlite = "node:sqlite";
    ({ DatabaseSync } = await import(nodeSqlite));
  } catch {
    console.warn("node:sqlite unavailable; skipping last-emission-error check");
    return;
  }

  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE document_events (
      id TEXT PRIMARY KEY, external_id TEXT, event TEXT, summary TEXT,
      detail_json TEXT, created_at TEXT
    );
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, shopify_domain TEXT, user_id TEXT,
      topic TEXT, payload TEXT, response TEXT, status INTEGER, created_at TEXT
    );
  `);
  for (const r of rows) {
    sqlite.prepare(
      "INSERT INTO logs (shopify_domain, topic, payload, response, status, created_at) VALUES (?, 'refunds/create', ?, ?, ?, ?)",
    ).run(r.shopify_domain, r.payload, r.response, r.status, r.created_at);
  }

  const env = {
    DB: {
      prepare(sql: string) {
        const stmt = sqlite.prepare(sql);
        let bound: unknown[] = [];
        const api = {
          bind(...args: unknown[]) { bound = args; return api; },
          async run() { return { meta: { changes: 0 } }; },
          async first() { return stmt.get(...bound) ?? null; },
          async all() { return { results: stmt.all(...bound) }; },
        };
        return api;
      },
    },
  };
  await fn(env);
}

/** saveLog JSON-encodes both columns, so the stored text is a quoted string. */
const stored = (s: string) => JSON.stringify(s);
const REFUSAL = "Error: InvoiceXpress finalize failed for credit note 270293802: "
  + '{"error":{"message":"The total can\'t be greater than the related documents\' total."}}';

describe("lookupLastEmissionError — a refusal is never reported as silence", () => {
  it("finds the destination's refusal even though the payload is empty", async () => {
    await withLogs(
      [{
        shopify_domain: "70wnnj-qa.myshopify.com",
        payload: stored(""),
        response: stored(REFUSAL),
        status: 500,
        created_at: new Date(Date.now() - 60_000).toISOString(),
      }],
      async (env) => {
        const found = await lookupLastEmissionError(env, "14137043747201", {
          shopifyDomain: "70wnnj-qa.myshopify.com",
        });
        expect(found).not.toBeNull();
        expect(found!.message).toContain("related documents' total");
        // Nothing in the row carries the order id, so this is the merchant-scoped
        // match and it must say so rather than pose as proof about this sale.
        expect(found!.approximate).toBe(true);
      },
    );
  });

  it("prefers an exact match and does not mark it approximate", async () => {
    await withLogs(
      [{
        shopify_domain: "166c6d-82.myshopify.com",
        payload: stored(""),
        response: stored("Error: InvoiceXpress credit create failed for refund 1041494901012: exemption missing"),
        status: 500,
        created_at: new Date(Date.now() - 60_000).toISOString(),
      }],
      async (env) => {
        const found = await lookupLastEmissionError(env, "1041494901012", {
          shopifyDomain: "166c6d-82.myshopify.com",
        });
        expect(found!.message).toContain("exemption missing");
        expect(found!.approximate).toBeFalsy();
      },
    );
  });

  it("never quotes another merchant's failure", async () => {
    await withLogs(
      [{
        shopify_domain: "outra-loja.myshopify.com",
        payload: stored(""),
        response: stored(REFUSAL),
        status: 500,
        created_at: new Date(Date.now() - 60_000).toISOString(),
      }],
      async (env) => {
        const found = await lookupLastEmissionError(env, "14137043747201", {
          shopifyDomain: "70wnnj-qa.myshopify.com",
        });
        expect(found).toBeNull();
      },
    );
  });

  it("does not reach back past a day for an unrelated failure", async () => {
    await withLogs(
      [{
        shopify_domain: "70wnnj-qa.myshopify.com",
        payload: stored(""),
        response: stored(REFUSAL),
        status: 500,
        created_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      }],
      async (env) => {
        const found = await lookupLastEmissionError(env, "14137043747201", {
          shopifyDomain: "70wnnj-qa.myshopify.com",
        });
        expect(found).toBeNull();
      },
    );
  });
});
