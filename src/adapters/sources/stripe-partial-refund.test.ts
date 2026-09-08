import { describe, it, expect } from "vitest";
import { stripeToNormalized } from "./stripe-source";

/**
 * A Stripe refund of part of a charge produced no credit note at all.
 *
 * `charge.refunded` is Stripe's FULLY-refunded flag: a charge refunded in part
 * carries `refunded: false` with a non-zero `amount_refunded`. The mapper gated
 * the credit on the boolean, so a partial refund emitted an empty `credits[]` —
 * and the pipeline, having nothing to loop over, reported success. Money left
 * the merchant's account and no document said so.
 *
 * The second half is the reference. Several partial refunds on one charge used
 * to collapse onto `refunds.data[0]`, so the second refund was issued under the
 * first one's reference and the pipeline's per-refund dedup then skipped it as
 * already credited.
 */

const charge = (over: any = {}) => ({
  type: "charge.refunded",
  data: {
    object: {
      id: "ch_3UD27zHtFLuAcUr80abcdefg",
      object: "charge",
      status: "succeeded",
      payment_intent: "pi_3UD27zHtFLuAcUr80PJtxuyc",
      currency: "eur",
      amount: 12_177,
      created: 1_757_000_000,
      description: "MeetFrank subscription",
      billing_details: { name: "Safe Days", email: "geral@safedays.pt", address: {} },
      ...over,
    },
  },
});

const normalize = (event: any) => {
  const n = stripeToNormalized(event);
  if (!n) throw new Error("event did not normalize");
  return n as any;
};

describe("Stripe refunds map to credit notes", () => {
  it("credits a PARTIAL refund, which the fully-refunded flag hid", async () => {
    const n = normalize(charge({
      refunded: false,                       // Stripe: not fully refunded
      amount_refunded: 3_000,
      refunds: { data: [{ id: "re_1partial", amount: 3_000, status: "succeeded" }] },
    }));

    expect(n.credits).toHaveLength(1);
    expect(n.credits[0]).toMatchObject({ refund_id: "re_1partial", amount: 30 });
    // No per-line breakdown: a synthetic line would collide with the full-value
    // order item and make the credit note cover the whole invoice.
    expect(n.credits[0].line_items).toEqual([]);
  });

  it("keeps two partial refunds on one charge as two credit notes", async () => {
    const n = normalize(charge({
      refunded: false,
      amount_refunded: 5_000,
      refunds: { data: [
        { id: "re_first", amount: 3_000, status: "succeeded" },
        { id: "re_second", amount: 2_000, status: "succeeded" },
      ] },
    }));

    expect(n.credits.map((c: any) => [c.refund_id, c.amount])).toEqual([
      ["re_first", 30],
      ["re_second", 20],
    ]);
  });

  it("still credits a full refund", async () => {
    const n = normalize(charge({
      refunded: true,
      amount_refunded: 12_177,
      refunds: { data: [{ id: "re_full", amount: 12_177, status: "succeeded" }] },
    }));

    expect(n.credits).toHaveLength(1);
    expect(n.credits[0]).toMatchObject({ refund_id: "re_full", amount: 121.77 });
  });

  it("falls back to the charge total when the refund list was not expanded", async () => {
    // A charge fetched without `expand[]=refunds` reports the total and nothing
    // else. Crediting that under the charge's own id beats crediting nothing.
    const n = normalize(charge({ refunded: false, amount_refunded: 3_000 }));

    expect(n.credits).toHaveLength(1);
    expect(n.credits[0]).toMatchObject({ amount: 30, refund_id: "ch_3UD27zHtFLuAcUr80abcdefg" });
  });

  it("ignores a refund that failed or was cancelled", async () => {
    const n = normalize(charge({
      refunded: false,
      amount_refunded: 3_000,
      refunds: { data: [
        { id: "re_ok", amount: 3_000, status: "succeeded" },
        { id: "re_dead", amount: 4_500, status: "failed" },
      ] },
    }));

    expect(n.credits.map((c: any) => c.refund_id)).toEqual(["re_ok"]);
  });

  it("credits nothing when nothing was refunded", async () => {
    const n = normalize(charge({ type: "charge.succeeded", refunded: false, amount_refunded: 0 }));
    expect(n.credits).toEqual([]);
  });
});
