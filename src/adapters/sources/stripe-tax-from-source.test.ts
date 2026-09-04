/**
 * Cover for the shape race on Stripe→IX: one card payment fires
 * `checkout.session.completed`, `payment_intent.succeeded` and
 * `charge.succeeded`, all three dedup onto the same PaymentIntent, and only the
 * session carries Stripe Tax's numbers. The other two map to a single 0% line,
 * so whichever webhook Stripe happened to deliver first decided whether a
 * VAT-charged sale was invoiced with VAT on it.
 *
 * The same gap made every recovery path lie: backfill, heal and re-emit all
 * synthesize a PaymentIntent, so re-issuing a Checkout sale replaced a taxed
 * document with an untaxed one.
 *
 * Behind `stripe_tax_from_source`. With the flag off — every connection
 * invoicing today — nothing is looked up and the mapping is what it was.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { StripeSource } from "./stripe-source";
import type { AdapterCtx } from "../types";

const PI_ID = "pi_3U3vtjJNp2FcbLOX1LzfGa73";

const piEvent = (over: Record<string, any> = {}) => ({
  type: "payment_intent.succeeded",
  data: {
    object: {
      id: PI_ID,
      status: "succeeded",
      amount: 12300,
      amount_received: 12300,
      currency: "eur",
      created: 1_756_000_000,
      description: "Order 4821",
      ...over,
    },
  },
});

/** The session Stripe Tax actually filled in: 100.00 net + 23.00 VAT. */
const session = (over: Record<string, any> = {}) => ({
  id: "cs_test_a1QeAKrOvTQdRk2yWXvIhBcJ",
  object: "checkout.session",
  payment_status: "paid",
  payment_intent: PI_ID,
  currency: "eur",
  created: 1_756_000_000,
  amount_total: 12300,
  total_details: { amount_tax: 2300, amount_discount: 0, amount_shipping: 0 },
  customer_details: { name: "Ana Marques", email: "ana@example.pt", tax_ids: [{ type: "eu_vat", value: "PT501442600" }] },
  ...over,
});

const ctx = (extra: any = {}): AdapterCtx => ({
  sourceConfig: { restricted_key: "rk_live_test" },
  config: { stripe_tax_from_source: 1, ...extra },
} as unknown as AdapterCtx);

/**
 * Routes by URL, like the identity test does. `sessions` is what
 * `/v1/checkout/sessions?payment_intent=` answers; `charge` feeds the
 * latest_charge expand every PI event does anyway.
 */
function stubStripe(sessions: any[], charge: Record<string, any> = {}) {
  const fetchMock = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("/checkout/sessions")) return ok({ data: sessions });
    if (u.includes("/invoices/")) return ok({ id: "in_1", object: "invoice" });
    return ok({ latest_charge: { billing_details: { name: null }, created: 1_756_000_000, ...charge } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const ok = (body: any) => ({ ok: true, json: async () => body } as unknown as Response);

const rate = (n: any) => Number(n.order.items[0].tax.value);
const unit = (n: any) => Number(n.order.items[0].unit_price);

afterEach(() => vi.unstubAllGlobals());

describe("VAT read from the checkout behind a PaymentIntent", () => {
  it("invoices the VAT the buyer actually paid instead of a 0% line", async () => {
    stubStripe([session()]);

    const n: any = await new StripeSource().toNormalized(piEvent(), ctx());

    expect(rate(n)).toBeCloseTo(23, 2);
    expect(unit(n)).toBeCloseTo(100, 2);
    // The paid total is never touched — only how it is broken down.
    expect(Number(n.order.total)).toBeCloseTo(123, 2);
  });

  it("brings across the tax ids the payment shapes never see", async () => {
    stubStripe([session()]);

    const n: any = await new StripeSource().toNormalized(piEvent(), ctx());

    const values = (n.order.note_attributes ?? []).map((a: any) => String(a.value));
    expect(values).toContain("PT501442600");
  });

  it("looks nothing up when the flag is off", async () => {
    const fetchMock = stubStripe([session()]);

    const n: any = await new StripeSource().toNormalized(piEvent(), ctx({ stripe_tax_from_source: 0 }));

    expect(rate(n)).toBe(0);
    expect(fetchMock.mock.calls.every(c => !String(c[0]).includes("/checkout/sessions"))).toBe(true);
  });

  it("refuses a session whose total is not the amount that was paid", async () => {
    // Same PaymentIntent id, different money: two sales got crossed, and
    // grafting the lines would invoice an amount nobody paid.
    stubStripe([session({ amount_total: 9900, total_details: { amount_tax: 1851 } })]);

    const n: any = await new StripeSource().toNormalized(piEvent(), ctx());

    expect(rate(n)).toBe(0);
    expect(Number(n.order.total)).toBeCloseTo(123, 2);
  });

  it("keeps the mapping when there is no session behind the payment", async () => {
    stubStripe([]);

    const n: any = await new StripeSource().toNormalized(piEvent(), ctx());

    expect(rate(n)).toBe(0);
    expect(Number(n.order.total)).toBeCloseTo(123, 2);
  });

  it("keeps the document dated by the payment, not by the session", async () => {
    // The Multibanco fix: a reference generated on day one and paid days later.
    // Reading the session must not drag the date back to when it was created.
    const paidAt = 1_756_600_000;
    stubStripe([session()], { created: paidAt });

    const n: any = await new StripeSource().toNormalized(piEvent(), ctx());

    expect(n.order.created_at).toBe(new Date(paidAt * 1000).toISOString());
  });

  it("survives a Stripe lookup that fails, rather than losing the sale", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).includes("/checkout/sessions")
        ? ({ ok: false, status: 403, json: async () => ({}) } as unknown as Response)
        : ok({ latest_charge: { created: 1_756_000_000 } })));

    const n: any = await new StripeSource().toNormalized(piEvent(), ctx());

    expect(rate(n)).toBe(0);
    expect(Number(n.order.total)).toBeCloseTo(123, 2);
  });
});
