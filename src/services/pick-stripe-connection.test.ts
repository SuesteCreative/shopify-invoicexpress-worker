import { describe, it, expect } from "vitest";
import { pickStripeConnection } from "./connection-context";

/**
 * One account, two Stripe integrations into different destinations.
 *
 * `stripe → invoicexpress` and `stripe → moloni` are separate rows with
 * separate series, exemption codes and tax settings. The queue consumer used to
 * load "an active connection for this user and source" with no destination
 * filter and no ORDER BY, so which of the two issued a document was SQLite's
 * choice — and it could differ between two events of the same sale.
 */

async function fakeDb(rows: Array<[string, string, string, string, string]>) {
  const nodeSqlite = "node:sqlite";
  const { DatabaseSync } = await import(nodeSqlite);
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE connections (
    id TEXT PRIMARY KEY, user_id TEXT, source_kind TEXT, destination_kind TEXT,
    source_config_json TEXT, destination_config_json TEXT, behavior_json TEXT,
    status TEXT, created_at TEXT
  );`);
  for (const [id, source, destination, status, created] of rows) {
    sqlite.exec(
      `INSERT INTO connections VALUES ('${id}','u1','${source}','${destination}',` +
      `'{}','{"marker":"${id}"}',NULL,'${status}','${created}')`,
    );
  }
  return {
    prepare(sql: string) {
      const stmt = sqlite.prepare(sql);
      let args: any[] = [];
      const api = {
        bind(...a: any[]) { args = a; return api; },
        async first() { return stmt.get(...args) ?? null; },
      };
      return api;
    },
  };
}

const marker = (row: any) => (row ? JSON.parse(row.destination_config_json).marker : null);

/** Both active, IX created first. */
const BOTH = async () => await fakeDb([
  ["ix", "stripe", "invoicexpress", "active", "2026-01-01T00:00:00Z"],
  ["mo", "stripe", "moloni", "active", "2026-06-01T00:00:00Z"],
]);

describe("pickStripeConnection", () => {
  it("returns the connection for the destination the event was enqueued for", async () => {
    const db = await BOTH();
    expect(marker(await pickStripeConnection(db, "u1", "stripe", "moloni"))).toBe("mo");
    expect(marker(await pickStripeConnection(db, "u1", "stripe", "invoicexpress"))).toBe("ix");
  });

  it("without a stated destination, takes the oldest — not whichever comes back first", async () => {
    // The case that matters is that it is DECIDED. A message enqueued before the
    // webhook started stamping the destination still has to land somewhere, and
    // twice in a row it must land in the same place.
    const db = await BOTH();
    const first = marker(await pickStripeConnection(db, "u1", "stripe"));
    const second = marker(await pickStripeConnection(db, "u1", "stripe"));
    expect(first).toBe("ix");
    expect(second).toBe(first);
  });

  it("falls back rather than dropping the sale when the stated destination is gone", async () => {
    // The connection was deleted or repointed while the event sat in the queue.
    const db = await fakeDb([["ix", "stripe", "invoicexpress", "active", "2026-01-01T00:00:00Z"]]);
    expect(marker(await pickStripeConnection(db, "u1", "stripe", "moloni"))).toBe("ix");
  });

  it("never returns an inactive connection", async () => {
    const db = await fakeDb([["old", "stripe", "moloni", "inactive", "2026-01-01T00:00:00Z"]]);
    expect(await pickStripeConnection(db, "u1", "stripe", "moloni")).toBeNull();
    expect(await pickStripeConnection(db, "u1", "stripe")).toBeNull();
  });

  it("does not cross source kinds — Connect is not the legacy connection", async () => {
    const db = await fakeDb([
      ["legacy", "stripe", "moloni", "active", "2026-01-01T00:00:00Z"],
      ["connect", "stripe_connect", "moloni", "active", "2026-06-01T00:00:00Z"],
    ]);
    expect(marker(await pickStripeConnection(db, "u1", "stripe_connect", "moloni"))).toBe("connect");
    expect(marker(await pickStripeConnection(db, "u1", "stripe", "moloni"))).toBe("legacy");
  });
});
