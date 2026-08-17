import { describe, it, expect } from "vitest";
import { lookupLastEmissionError } from "./document-log";

/**
 * The dead-letter alert used to say only that the retries ran out. The reason
 * was on disk both times it failed — as a `create_failed` event, or as the log
 * row the legacy handler writes — and nothing read it back, so the loudest
 * email the platform sends was the emptiest.
 *
 * These queries are the join-back. They run against real SQL here because the
 * two things most likely to break them are SQL-shaped and invisible to a mock:
 * `saveLog` JSON-encodes the columns before storing (so the stored text is a
 * QUOTED string, which an anchored LIKE never matches), and the scoping clause
 * is what stops one merchant's alert quoting another merchant's error.
 */

type Row = Record<string, unknown>;

/** Minimal D1 shim over node:sqlite — same surface the helper actually uses. */
async function makeEnv(seed: (exec: (sql: string, ...args: unknown[]) => void) => void) {
  let DatabaseSync: any;
  try {
    const nodeSqlite = "node:sqlite";
    ({ DatabaseSync } = await import(nodeSqlite));
  } catch {
    return null;
  }

  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE document_events (
    id TEXT PRIMARY KEY, external_id TEXT, user_id TEXT, event TEXT NOT NULL,
    summary TEXT, detail_json TEXT, created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE logs (
    id TEXT PRIMARY KEY, shopify_domain TEXT, user_id TEXT, topic TEXT,
    payload TEXT, response TEXT, status INTEGER, created_at TEXT
  )`);
  seed((sql, ...args) => db.prepare(sql).run(...args));

  const env = {
    DB: {
      prepare(sql: string) {
        const bound: unknown[] = [];
        const api = {
          bind(...args: unknown[]) { bound.push(...args); return api; },
          async first<T = Row>(): Promise<T | null> {
            return (db.prepare(sql).get(...bound) as T) ?? null;
          },
        };
        return api;
      },
    },
  } as any;

  return { env, close: () => db.close() };
}

/** How storage.saveLog actually writes: JSON.stringify on both columns. */
const asSaved = (v: unknown) => JSON.stringify(v);

describe("lookupLastEmissionError", () => {
  it("prefers the document timeline, and carries the status with it", async () => {
    const h = await makeEnv((run) => {
      run(
        `INSERT INTO document_events (id, external_id, user_id, event, summary, detail_json, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        "e1", "7781137449306", "u1", "create_failed",
        "O InvoiceXpress recusou emitir o documento",
        JSON.stringify({ error: '{"message":"Fiscal is invalid"}', http_status: 422 }),
        "2026-08-16T10:00:00.000Z",
      );
    });
    if (!h) return;

    const got = await lookupLastEmissionError(h.env, "7781137449306", { shopifyDomain: "angel.myshopify.com" });
    expect(got?.source).toBe("document_events");
    expect(got?.message).toContain("Fiscal is invalid");
    expect(got?.http_status).toBe(422);
    h.close();
  });

  it("takes the most recent failure when a sale failed on several days", async () => {
    const h = await makeEnv((run) => {
      const ins = `INSERT INTO document_events (id, external_id, user_id, event, summary, detail_json, created_at)
                   VALUES (?,?,?,?,?,?,?)`;
      run(ins, "old", "555", "u1", "create_failed", "s", JSON.stringify({ error: "erro antigo" }), "2026-08-10T09:00:00.000Z");
      run(ins, "new", "555", "u1", "create_failed", "s", JSON.stringify({ error: "erro recente" }), "2026-08-16T09:00:00.000Z");
    });
    if (!h) return;

    const got = await lookupLastEmissionError(h.env, "555", { userId: "u1" });
    expect(got?.message).toBe("erro recente");
    h.close();
  });

  it("falls back to the log row the legacy handler wrote, quotes and all", async () => {
    const h = await makeEnv((run) => {
      run(
        `INSERT INTO logs (id, shopify_domain, user_id, topic, payload, response, status, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        "l1", "angel.myshopify.com", "u1", "orders/created",
        asSaved(JSON.stringify({ orderId: 7781137449306 })),
        asSaved('IX create failed (HTTP 422): {"message":"Fiscal is invalid"}'),
        500, "2026-08-16T10:00:00.000Z",
      );
    });
    if (!h) return;

    const got = await lookupLastEmissionError(h.env, "7781137449306", { shopifyDomain: "angel.myshopify.com" });
    expect(got?.source).toBe("logs");
    // Parsed back out of the stored JSON string — no stray leading quote.
    expect(got?.message.startsWith("IX create failed")).toBe(true);
    expect(got?.message).toContain("Fiscal is invalid");
    h.close();
  });

  it("never quotes another merchant's error", async () => {
    const h = await makeEnv((run) => {
      run(
        `INSERT INTO logs (id, shopify_domain, user_id, topic, payload, response, status, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        "l1", "other-shop.myshopify.com", "u2", "orders/created",
        asSaved(JSON.stringify({ orderId: 999 })),
        asSaved("IX create failed: segredo de outro cliente"),
        500, "2026-08-16T10:00:00.000Z",
      );
    });
    if (!h) return;

    const got = await lookupLastEmissionError(h.env, "999", { shopifyDomain: "angel.myshopify.com" });
    expect(got).toBeNull();
    h.close();
  });

  it("returns null when nothing was ever recorded, so the caller can say so", async () => {
    const h = await makeEnv(() => {});
    if (!h) return;
    expect(await lookupLastEmissionError(h.env, "404", { shopifyDomain: "angel.myshopify.com" })).toBeNull();
    // An unresolvable id must not even be asked about.
    expect(await lookupLastEmissionError(h.env, "unknown", { shopifyDomain: "angel.myshopify.com" })).toBeNull();
    h.close();
  });

  it("does not guess a scope it was not given", async () => {
    const h = await makeEnv((run) => {
      run(
        `INSERT INTO logs (id, shopify_domain, user_id, topic, payload, response, status, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        "l1", "angel.myshopify.com", "u1", "orders/created",
        asSaved(JSON.stringify({ orderId: 123 })),
        asSaved("IX create failed: algo"),
        500, "2026-08-16T10:00:00.000Z",
      );
    });
    if (!h) return;

    expect(await lookupLastEmissionError(h.env, "123", {})).toBeNull();
    h.close();
  });
});
