import { describe, it, expect, vi } from "vitest";
import { autoResolveStaleIncidents } from "./incidents";

/**
 * The regression this file exists for.
 *
 * The verification filtered affected ids with `/^d{10,}$/` — the letter `d`,
 * not a digit — so no Shopify order id ever survived it, `ids.length === 0`
 * was always true, and EVERY quiet invoice-failure incident was closed
 * unverified after 24h. That is precisely the behaviour the Zoo de Lagos
 * comment above the code says must never come back: the healer works off open
 * incidents, so closing them empties its work list and the orders stay unbilled
 * forever. Measured on Soul Krave (14/09/2026): 8 of 11 `subscription_inactive`
 * incidents auto_resolved with no document anywhere.
 */

const invoiced = new Set<string>();
vi.mock("../storage", () => ({
  AppStorage: class {
    async getInvoicedOrderIdsAnySource(ids: string[]) {
      return new Set(ids.filter((id) => invoiced.has(id)));
    }
  },
}));

/** Minimal D1 double: routes by statement text, records the auto_resolve ids. */
function fakeDb(stale: Array<{ id: string; affected_ids_json: string }>, closed: string[]) {
  return {
    prepare(sql: string) {
      const stmt: any = {
        bind: (...args: any[]) => {
          stmt.args = args;
          return stmt;
        },
        all: async () => (sql.includes("SELECT id, affected_ids_json") ? { results: stale } : { results: [] }),
        run: async () => {
          if (sql.includes("status = 'auto_resolved'") && sql.includes("WHERE id = ?")) {
            closed.push(String(stmt.args[1]));
          }
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  };
}

describe("autoResolveStaleIncidents", () => {
  it("keeps a quiet-but-unbilled incident open so the healer can still see it", async () => {
    invoiced.clear();
    const closed: string[] = [];
    const env: any = { DB: fakeDb([{ id: "inc-1", affected_ids_json: '["7428630446300"]' }], closed) };

    const res = await autoResolveStaleIncidents(env);

    expect(closed).toEqual([]);
    expect(res.keptUnbilled).toBe(1);
  });

  it("closes it once the order has a document", async () => {
    invoiced.clear();
    invoiced.add("7428630446300");
    const closed: string[] = [];
    const env: any = { DB: fakeDb([{ id: "inc-1", affected_ids_json: '["7428630446300"]' }], closed) };

    const res = await autoResolveStaleIncidents(env);

    expect(closed).toEqual(["inc-1"]);
    expect(res.keptUnbilled).toBe(0);
  });

  it("still falls back to closing what it cannot check (a Lodgify booking, a refund ref)", async () => {
    invoiced.clear();
    const closed: string[] = [];
    const env: any = { DB: fakeDb([{ id: "inc-2", affected_ids_json: '["pi_3UFUUcJwZ8gzmNr41jJejqng"]' }], closed) };

    const res = await autoResolveStaleIncidents(env);

    expect(closed).toEqual(["inc-2"]);
    expect(res.keptUnbilled).toBe(0);
  });
});

/**
 * The second lie in the same table: right about the failure, wrong about now.
 *
 * Verification only ran on incidents that had been quiet for 24h, so an order
 * the healer invoiced at 09:05 stayed `open` — and red on every surface that
 * reads open incidents — until the following night. A document exists; that is
 * the only thing that settles it, and there is no reason to wait a day to ask.
 */
describe("autoResolveStaleIncidents — a fresh incident is verified too", () => {
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  it("closes a fresh incident whose order has since been invoiced", async () => {
    invoiced.clear();
    invoiced.add("7428630446300");
    const closed: string[] = [];
    const env: any = { DB: fakeDb(
      [{ id: "inc-3", affected_ids_json: '["7428630446300"]', last_seen_at: recent } as any], closed) };

    const res = await autoResolveStaleIncidents(env);

    expect(closed).toEqual(["inc-3"]);
    expect(res.keptUnbilled).toBe(0);
  });

  it("keeps a fresh incident it cannot check, instead of closing it unverified", async () => {
    invoiced.clear();
    const closed: string[] = [];
    const env: any = { DB: fakeDb(
      [{ id: "inc-4", affected_ids_json: '["pi_3UFUUcJwZ8gzmNr41jJejqng"]', last_seen_at: recent } as any], closed) };

    const res = await autoResolveStaleIncidents(env);

    // The 24h fallback is what closes an unverifiable one, and it has not run
    // out yet. Closing it now would delete the alarm rather than the problem.
    expect(closed).toEqual([]);
    expect(res.keptUnbilled).toBe(1);
  });

  it("keeps a fresh incident whose order is still unbilled", async () => {
    invoiced.clear();
    const closed: string[] = [];
    const env: any = { DB: fakeDb(
      [{ id: "inc-5", affected_ids_json: '["7428630446300"]', last_seen_at: recent } as any], closed) };

    const res = await autoResolveStaleIncidents(env);

    expect(closed).toEqual([]);
    expect(res.keptUnbilled).toBe(1);
  });
});
