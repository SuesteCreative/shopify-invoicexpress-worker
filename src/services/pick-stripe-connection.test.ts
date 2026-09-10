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
 *
 * The fake below answers the two queries the helper can issue AND records them,
 * so the test pins both the row that comes back and the SQL that asked for it.
 * That distinction matters: a missing ORDER BY is invisible in a result. The
 * query returns a plausible row every time, and only stops doing so in
 * production, under a different row order, months later.
 *
 * Deliberately not `node:sqlite`: it landed in Node 22.5 and CI runs 20, where
 * the module does not exist. The repo's other SQL tests skip themselves there,
 * which means they protect nothing in the one place it matters. This one runs
 * everywhere.
 */

interface Row {
  id: string;
  source_kind: string;
  destination_kind: string;
  status: string;
  created_at: string;
}

function fakeDb(rows: Row[]) {
  const asked: Array<{ sql: string; binds: any[] }> = [];

  const run = (sql: string, binds: any[]): Row | null => {
    const [, sourceKind, destinationKind] = binds;
    // Every query the helper issues scopes to the user, the source and 'active'.
    let out = rows.filter((r) => r.source_kind === sourceKind && r.status === "active");
    if (/destination_kind = \?/.test(sql)) {
      out = out.filter((r) => r.destination_kind === destinationKind);
    }
    if (/ORDER BY created_at ASC/.test(sql)) {
      out = [...out].sort((a, b) => a.created_at.localeCompare(b.created_at));
    } else {
      // No ordering asked for, so the store is free to answer in any order —
      // and this one answers in the WORST order on purpose, so that dropping
      // the ORDER BY turns a passing test red instead of leaving it green.
      out = [...out].reverse();
    }
    return out[0] ?? null;
  };

  return {
    asked,
    prepare(sql: string) {
      const entry = { sql, binds: [] as any[] };
      const api = {
        bind(...b: any[]) { entry.binds = b; return api; },
        async first() { asked.push(entry); return run(sql, entry.binds); },
      };
      return api;
    },
  };
}

const IX: Row = { id: "ix", source_kind: "stripe", destination_kind: "invoicexpress", status: "active", created_at: "2026-01-01T00:00:00Z" };
const MO: Row = { id: "mo", source_kind: "stripe", destination_kind: "moloni", status: "active", created_at: "2026-06-01T00:00:00Z" };

describe("pickStripeConnection", () => {
  it("returns the connection for the destination the event was enqueued for", async () => {
    const db = fakeDb([IX, MO]);
    expect((await pickStripeConnection(db, "u1", "stripe", "moloni"))?.id).toBe("mo");
    expect((await pickStripeConnection(db, "u1", "stripe", "invoicexpress"))?.id).toBe("ix");
    // One query each: the exact match answered, so no fallback was needed.
    expect(db.asked).toHaveLength(2);
    expect(db.asked[0].binds).toEqual(["u1", "stripe", "moloni"]);
  });

  it("orders the fallback instead of taking whichever row comes back first", async () => {
    // A message enqueued before the webhook started stamping the destination
    // still has to land somewhere, and twice in a row it must land in the SAME
    // place. The fake answers an unordered query worst-first, so this fails the
    // moment the ORDER BY goes.
    const db = fakeDb([IX, MO]);
    const first = await pickStripeConnection(db, "u1", "stripe");
    const second = await pickStripeConnection(db, "u1", "stripe");

    expect(first?.id).toBe("ix");
    expect(second?.id).toBe(first?.id);
    expect(db.asked[0].sql).toMatch(/ORDER BY created_at ASC/);
    expect(db.asked[0].sql).not.toMatch(/destination_kind = \?/);
  });

  it("falls back rather than dropping the sale when the stated destination is gone", async () => {
    // The connection was deleted or repointed while the event sat in the queue.
    const db = fakeDb([IX]);
    expect((await pickStripeConnection(db, "u1", "stripe", "moloni"))?.id).toBe("ix");
    // Asked precisely, found nothing, then asked broadly.
    expect(db.asked).toHaveLength(2);
    expect(db.asked[0].sql).toMatch(/destination_kind = \?/);
    expect(db.asked[1].sql).toMatch(/ORDER BY created_at ASC/);
  });

  it("never returns an inactive connection", async () => {
    const db = fakeDb([{ ...MO, status: "inactive" }]);
    expect(await pickStripeConnection(db, "u1", "stripe", "moloni")).toBeNull();
    expect(await pickStripeConnection(db, "u1", "stripe")).toBeNull();
    for (const q of db.asked) expect(q.sql).toMatch(/status = 'active'/);
  });

  it("does not cross source kinds — Connect is not the legacy connection", async () => {
    const db = fakeDb([
      { ...MO, id: "legacy" },
      { ...MO, id: "connect", source_kind: "stripe_connect", created_at: "2026-06-02T00:00:00Z" },
    ]);
    expect((await pickStripeConnection(db, "u1", "stripe_connect", "moloni"))?.id).toBe("connect");
    expect((await pickStripeConnection(db, "u1", "stripe", "moloni"))?.id).toBe("legacy");
  });
});
