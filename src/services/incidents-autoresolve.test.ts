import { describe, it, expect, vi } from "vitest";
import { autoResolveStaleIncidents, isVerifiableOrderRef } from "./incidents";

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

/** Ids with a document through the storage fallback (a hand match): invoiced, nothing to certify. */
const invoiced = new Set<string>();
vi.mock("../storage", () => ({
  AppStorage: class {
    async getInvoicedOrderIdsAnySource(ids: string[]) {
      return new Set(ids.filter((id) => invoiced.has(id)));
    }
  },
}));

type Evidence = Partial<Record<"held" | "finalized" | "expects_finalize" | "credit_issued_since" | "credit_in_flight", number>>;

/**
 * Minimal D1 double: routes by statement text, records every close by id.
 * `evidence` is what the processed_orders query answers for an id; an id absent
 * from it falls through to the storage mock above.
 */
function fakeDb(
  stale: Array<{ id: string; affected_ids_json: string; kind?: string; topic?: string | null; last_seen_at?: string }>,
  closed: string[],
  evidence: Record<string, Evidence> = {},
) {
  const rows = stale.map((r) => ({ kind: "destination_reject", topic: null, first_seen_at: "2026-09-15T12:00:00.000Z", ...r }));
  return {
    prepare(sql: string) {
      const stmt: any = {
        bind: (...args: any[]) => {
          stmt.args = args;
          return stmt;
        },
        all: async () => {
          if (sql.includes("FROM processed_orders po")) {
            const ids: string[] = stmt.args.slice(1);
            return { results: ids.filter((id) => id in evidence).map((id) => ({
              id, held: 0, finalized: 1, expects_finalize: 1, credit_issued_since: 0, credit_in_flight: 0, ...evidence[id],
            })) };
          }
          if (sql.includes("FROM incidents")) return { results: rows.filter((r) => !closed.includes(r.id)) };
          return { results: [] };
        },
        run: async () => {
          if (sql.includes("UPDATE incidents") && sql.includes("WHERE id = ?")) {
            closed.push(String(stmt.args[1]));
            return { meta: { changes: 1 } };
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
    // A PaymentIntent used to stand here as the example of an uncheckable
    // reference. It never was one — `processed_orders` is keyed by `pi_` for
    // every Stripe source — so the example moved to a reference that genuinely
    // cannot be looked up anywhere.
    const env: any = { DB: fakeDb([{ id: "inc-2", affected_ids_json: '["riokohc-2026-09"]' }], closed) };

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
      [{ id: "inc-3", affected_ids_json: '["7428630446300"]', last_seen_at: recent }], closed) };

    const res = await autoResolveStaleIncidents(env);

    expect(closed).toEqual(["inc-3"]);
    expect(res.keptUnbilled).toBe(0);
  });

  it("keeps a fresh incident it cannot check, instead of closing it unverified", async () => {
    invoiced.clear();
    const closed: string[] = [];
    const env: any = { DB: fakeDb(
      [{ id: "inc-4", affected_ids_json: '["evt_3UFUUcJwZ8gzmNr41jJejqng"]', last_seen_at: recent }], closed) };

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
      [{ id: "inc-5", affected_ids_json: '["7428630446300"]', last_seen_at: recent }], closed) };

    const res = await autoResolveStaleIncidents(env);

    expect(closed).toEqual([]);
    expect(res.keptUnbilled).toBe(1);
  });
});

/**
 * Which references are worth verifying.
 *
 * `^\d{10,}$` is a Shopify order id and nothing else, so every Stripe-sourced
 * alarm fell into the "cannot check" branch and was closed unverified on the
 * 24h clock — the exact behaviour this file's first test exists to prevent,
 * applied to half the fleet without anyone noticing. Counted in production on
 * 2026-09-15, `processed_orders` is keyed by four shapes and no others.
 */
describe("isVerifiableOrderRef", () => {
  it("takes the four key shapes processed_orders actually holds", () => {
    expect(isVerifiableOrderRef("13460130824517")).toBe(true);
    expect(isVerifiableOrderRef("pi_3UF8FQJNp2FcbLOX0rD1lZCz")).toBe(true);
    expect(isVerifiableOrderRef("in_1TUXK7BTTqGjulMGabcdefgh")).toBe(true);
    expect(isVerifiableOrderRef("cs_test_a1b2c3d4e5f6g7h8")).toBe(true);
  });

  it("refuses a Stripe event id, which is never an order key", () => {
    // The shape behind the MY VAN phantom digest: it can never verify, so
    // treating it as checkable would keep a meaningless alarm open forever.
    expect(isVerifiableOrderRef("evt_3UF8FQJNp2FcbLOX0rD1lZCz")).toBe(false);
  });

  it("refuses free text and short numbers", () => {
    expect(isVerifiableOrderRef("riokohc")).toBe(false);
    expect(isVerifiableOrderRef("LLJCSSOJ-0042")).toBe(false);
    expect(isVerifiableOrderRef("12345")).toBe(false);
    expect(isVerifiableOrderRef("")).toBe(false);
  });
});

describe("autoResolveStaleIncidents — a Stripe reference is verified like any other", () => {
  it("keeps a pi_ incident open while its payment is still unbilled", async () => {
    invoiced.clear();
    const closed: string[] = [];
    const env: any = { DB: fakeDb(
      [{ id: "inc-6", affected_ids_json: '["pi_3UF8FQJNp2FcbLOX0rD1lZCz"]' }], closed) };

    const res = await autoResolveStaleIncidents(env);

    // Before this, the id failed the filter, the incident counted as
    // "unverifiable" and was closed after 24h with the sale still uninvoiced.
    expect(closed).toEqual([]);
    expect(res.keptUnbilled).toBe(1);
  });

  it("closes it once that payment has a document", async () => {
    invoiced.clear();
    invoiced.add("pi_3UF8FQJNp2FcbLOX0rD1lZCz");
    const closed: string[] = [];
    const env: any = { DB: fakeDb(
      [{ id: "inc-7", affected_ids_json: '["pi_3UF8FQJNp2FcbLOX0rD1lZCz"]' }], closed) };

    const res = await autoResolveStaleIncidents(env);

    expect(closed).toEqual(["inc-7"]);
    expect(res.keptUnbilled).toBe(0);
  });

  it("still closes an evt_ reference on the clock, since it can never verify", async () => {
    invoiced.clear();
    const closed: string[] = [];
    const env: any = { DB: fakeDb(
      [{ id: "inc-8", affected_ids_json: '["evt_3UF8FQJNp2FcbLOX0rD1lZCz"]' }], closed) };

    const res = await autoResolveStaleIncidents(env);

    expect(closed).toEqual(["inc-8"]);
    expect(res.keptUnbilled).toBe(0);
  });
});

/**
 * "A row exists" was the whole check, and two things it could not see closed
 * incidents that were still real (15/09/2026 review of WHM's alarms): the row
 * is written before the finalize call, so a finalize failure left a row and a
 * draft; and a refund's sale is always invoiced, so a missing credit note read
 * as done.
 */
describe("autoResolveStaleIncidents — closes on evidence, not on a row", () => {
  const PI = "pi_3UFvliLXiybx6Vcz1667s22k";

  it("keeps a finalize failure that left a draft open", async () => {
    invoiced.clear();
    const closed: string[] = [];
    const env: any = { DB: fakeDb([{ id: "inc-9", affected_ids_json: JSON.stringify([PI]), topic: "paid" }], closed,
      { [PI]: { finalized: 0 } }) };

    const res = await autoResolveStaleIncidents(env);

    expect(closed).toEqual([]);
    expect(res.keptUnbilled).toBe(1);
  });

  it("judges a refund by its credit note, not by the sale's invoice", async () => {
    invoiced.clear();
    const noCredit: string[] = [];
    await autoResolveStaleIncidents({ DB: fakeDb(
      [{ id: "inc-10", kind: "queue_retry_exhausted", affected_ids_json: JSON.stringify([PI]), topic: "refund" }], noCredit,
      { [PI]: {} }) } as any);
    expect(noCredit).toEqual([]);

    const credited: string[] = [];
    await autoResolveStaleIncidents({ DB: fakeDb(
      [{ id: "inc-10", kind: "queue_retry_exhausted", affected_ids_json: JSON.stringify([PI]), topic: "refund" }], credited,
      { [PI]: { credit_issued_since: 1 } }) } as any);
    expect(credited).toEqual(["inc-10"]);
  });
});
