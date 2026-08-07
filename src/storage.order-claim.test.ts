import { describe, it, expect } from "vitest";
import { AppStorage } from "./storage";

// One order, one document. These pin the compare-and-swap that replaced the
// check-then-act in handleOrderCreated: two orders/created deliveries used to
// land in overlapping Worker invocations, both read "not processed", and both
// created a document — 60 orphan duplicate drafts on a single shop.

/** A D1 stand-in that honours PRIMARY KEY on (shopify_domain, order_id). */
function fakeDb(rows = new Map<string, string>()) {
  return {
    rows,
    prepare(sql: string) {
      let args: any[] = [];
      const api = {
        bind(...a: any[]) { args = a; return api; },
        async run() {
          if (sql.startsWith("INSERT OR IGNORE INTO order_claims")) {
            const [shop, order, at] = args;
            const key = `${shop}|${order}`;
            if (rows.has(key)) return { meta: { changes: 0 } };
            rows.set(key, at);
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE order_claims")) {
            const [at, shop, order, cutoff] = args;
            const key = `${shop}|${order}`;
            const held = rows.get(key);
            if (held === undefined || !(held < cutoff)) return { meta: { changes: 0 } };
            rows.set(key, at);
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("DELETE FROM order_claims")) {
            const [shop, order] = args;
            rows.delete(`${shop}|${order}`);
            return { meta: { changes: 1 } };
          }
          throw new Error(`unexpected sql: ${sql}`);
        },
        async first() { return null; },
      };
      return api;
    },
  } as any;
}

const storage = (db: any) => new AppStorage({ DB: db, INVOICE_KV: {} as any } as any, "shop.myshopify.com");

describe("claimOrder", () => {
  it("lets exactly one of two concurrent deliveries through", async () => {
    const db = fakeDb();
    const a = storage(db), b = storage(db);
    const [first, second] = await Promise.all([a.claimOrder("1001"), b.claimOrder("1001")]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it("frees the order once the winner releases it", async () => {
    const db = fakeDb();
    const s = storage(db);
    expect(await s.claimOrder("1001")).toBe(true);
    expect(await s.claimOrder("1001")).toBe(false);
    await s.releaseOrderClaim("1001");
    expect(await s.claimOrder("1001")).toBe(true);
  });

  it("does not let one crashed invocation make an order un-invoiceable for ever", async () => {
    const db = fakeDb();
    const s = storage(db);
    expect(await s.claimOrder("1001")).toBe(true);
    // The holder died an hour ago. A later delivery takes the stale claim over.
    db.rows.set("shop.myshopify.com|1001", new Date(Date.now() - 3600_000).toISOString());
    expect(await s.claimOrder("1001")).toBe(true);
    // …but a claim taken a moment ago is still someone else's.
    expect(await s.claimOrder("1001")).toBe(false);
  });

  it("keeps orders apart", async () => {
    const db = fakeDb();
    const s = storage(db);
    expect(await s.claimOrder("1001")).toBe(true);
    expect(await s.claimOrder("1002")).toBe(true);
  });

  it("fails OPEN when the claim table cannot be reached", async () => {
    // An unreachable lock table must never stop invoicing: a duplicate draft is
    // recoverable, an order that never invoices is not.
    const broken = { prepare() { throw new Error("D1 down"); } } as any;
    expect(await storage(broken).claimOrder("1001")).toBe(true);
  });
});
