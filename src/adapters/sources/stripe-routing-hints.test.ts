/**
 * Routing a Stripe account that collects money in more than one way.
 *
 * A booking plugin creating PaymentIntents through the API, Payment Links and
 * Checkout, and invoices marked as paid outside Stripe all land in the same
 * account, and each stream may have to be filed in its own document series.
 * `matchTagRouting` only ever saw order tags and metadata, so a stream whose
 * software writes no metadata could not be routed at all — and one whose
 * metadata sits on the Checkout Session matched or missed depending on which of
 * the three webhooks Stripe delivered first.
 *
 * Behind `stripe_routing_hints`. With the flag off — every connection invoicing
 * today — nothing is looked up and the mapping is what it was.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { StripeSource, buildStripeRoutingHints } from "./stripe-source";
import { matchTagRouting } from "../../services/tag-routing";
import type { AdapterCtx } from "../types";

const PI_ID = "pi_3U3vtjJNp2FcbLOX1LzfGa73";

const piEvent = (over: Record<string, any> = {}) => ({
  type: "payment_intent.succeeded",
  data: {
    object: {
      id: PI_ID,
      status: "succeeded",
      amount: 4500,
      amount_received: 4500,
      currency: "eur",
      created: 1_756_000_000,
      description: "Bookly appointment",
      payment_method_types: ["card"],
      ...over,
    },
  },
});

const chargeEvent = (over: Record<string, any> = {}) => ({
  type: "charge.succeeded",
  data: {
    object: {
      id: "ch_3U3vtjJNp2FcbLOX1kQyEXam",
      payment_intent: PI_ID,
      status: "succeeded",
      amount: 4500,
      currency: "eur",
      created: 1_756_000_000,
      description: "Bookly appointment",
      payment_method_details: { type: "card" },
      billing_details: { name: "Ana Marques", email: "ana@example.pt" },
      ...over,
    },
  },
});

const session = (over: Record<string, any> = {}) => ({
  id: "cs_test_a1QeAKrOvTQdRk2yWXvIhBcJ",
  object: "checkout.session",
  payment_status: "paid",
  payment_intent: PI_ID,
  currency: "eur",
  created: 1_756_000_000,
  amount_total: 4500,
  mode: "payment",
  metadata: { booking_source: "loja" },
  total_details: { amount_tax: 0, amount_discount: 0, amount_shipping: 0 },
  customer_details: { name: "Ana Marques", email: "ana@example.pt" },
  ...over,
});

const ctx = (extra: any = {}): AdapterCtx => ({
  sourceConfig: { restricted_key: "rk_live_test" },
  config: { stripe_routing_hints: 1, ...extra },
} as unknown as AdapterCtx);

const ok = (body: any) => ({ ok: true, json: async () => body } as unknown as Response);
const fail = (status: number) => ({ ok: false, status, json: async () => ({}) } as unknown as Response);

/** `sessions: null` means the session lookup itself errors, which is a
 *  different answer from "there is no session behind this payment". */
function stubStripe(sessions: any[] | null) {
  const fetchMock = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("/checkout/sessions")) return sessions === null ? fail(503) : ok({ data: sessions });
    if (u.includes("/invoices/")) return ok({ id: "in_1", object: "invoice" });
    return ok({ latest_charge: { billing_details: { name: null }, created: 1_756_000_000 } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const hintsOf = (n: any): string[] => n?.order?.meta?.routing_hints ?? [];

afterEach(() => vi.unstubAllGlobals());

describe("stripe routing hints", () => {
  it("says nothing and looks nothing up when the flag is off", async () => {
    const fetchMock = stubStripe([session()]);

    const n: any = await new StripeSource().toNormalized(piEvent(), ctx({ stripe_routing_hints: 0 }));

    expect(hintsOf(n)).toEqual([]);
    expect(fetchMock.mock.calls.every(c => !String(c[0]).includes("/checkout/sessions"))).toBe(true);
  });

  it("names the surface that created the sale", async () => {
    stubStripe([session()]);

    const n: any = await new StripeSource().toNormalized(piEvent(), ctx());

    expect(hintsOf(n)).toContain("stripe:origin:checkout");
  });

  it("calls a payment with nothing behind it an API payment", async () => {
    // No Checkout Session and no Stripe invoice: something created the
    // PaymentIntent directly — a booking plugin, a POS, the merchant's own code.
    stubStripe([]);

    const n: any = await new StripeSource().toNormalized(piEvent(), ctx());

    expect(hintsOf(n)).toContain("stripe:origin:api");
  });

  it("answers the origin the same way whichever webhook arrives first", async () => {
    // The three events of one card payment dedup onto the PaymentIntent, so a
    // hint that differed between them would make the series a coin flip.
    stubStripe([]);
    const fromPI: any = await new StripeSource().toNormalized(piEvent(), ctx());
    stubStripe([]);
    const fromCharge: any = await new StripeSource().toNormalized(chargeEvent(), ctx());

    expect(hintsOf(fromPI)).toContain("stripe:origin:api");
    expect(hintsOf(fromCharge)).toContain("stripe:origin:api");
  });

  it("claims no origin when Stripe could not be asked", async () => {
    // A failed lookup is not evidence of an API-created payment, and guessing
    // would file the sale in another stream's series.
    stubStripe(null);

    const n: any = await new StripeSource().toNormalized(piEvent(), ctx());

    expect(hintsOf(n).some(h => h.startsWith("stripe:origin:"))).toBe(false);
    expect(hintsOf(n)).toContain("stripe:description:bookly appointment");
  });

  it("carries how the money arrived and what the payment calls itself", async () => {
    stubStripe([]);

    const n: any = await new StripeSource().toNormalized(chargeEvent(), ctx());

    expect(hintsOf(n)).toContain("stripe:payment_method:card");
    expect(hintsOf(n)).toContain("stripe:description:bookly appointment");
  });

  it("marks money collected outside Stripe", async () => {
    const invoiceEvent = {
      type: "invoice.paid",
      data: {
        object: {
          id: "in_1PqWmQJNp2FcbLOX",
          object: "invoice",
          currency: "eur",
          created: 1_756_000_000,
          amount_paid: 6000,
          total: 6000,
          paid_out_of_band: true,
          billing_reason: "manual",
          status_transitions: { paid_at: 1_756_000_100 },
          lines: { data: [{ description: "Consulta", quantity: 1, amount: 6000 }] },
        },
      },
    };
    stubStripe([]);

    const n: any = await new StripeSource().toNormalized(invoiceEvent, ctx());

    expect(hintsOf(n)).toContain("stripe:origin:invoice");
    expect(hintsOf(n)).toContain("stripe:paid_out_of_band");
    expect(hintsOf(n)).toContain("stripe:billing_reason:manual");
  });

  it("reads the metadata off the session the payment event never carried", async () => {
    stubStripe([session()]);

    const n: any = await new StripeSource().toNormalized(piEvent(), ctx());

    const pairs = (n.order.note_attributes ?? []).map((a: any) => `${a.name}:${a.value}`);
    expect(pairs).toContain("booking_source:loja");
  });

  it("carries the price, for streams told apart by what they cost", async () => {
    stubStripe([]);

    const n: any = await new StripeSource().toNormalized(piEvent(), ctx());

    expect(hintsOf(n)).toContain("stripe:amount:45.00");
    expect(hintsOf(n)).toContain("stripe:amount:eur:45.00");
  });

  it("routes a fixed-price booking on its price alone", async () => {
    // The case where the booking plugin writes no metadata at all: its services
    // have three fixed prices, and nothing the merchant sells by hand costs the
    // same.
    stubStripe([]);
    const n: any = await new StripeSource().toNormalized(piEvent(), ctx());

    const rule = matchTagRouting(n.order, [
      { tag_name: "stripe:amount:45.00", document_type: "invoice_receipt", series_name: "BOOKLY", finalize_mode: "draft" },
    ]);

    expect(rule?.series_name).toBe("BOOKLY");
  });

  it("does not route a booking whose price was discounted", async () => {
    // Falls to the connection's own series rather than guessing — a document in
    // the wrong series is worse than one in the default series.
    stubStripe([]);
    const n: any = await new StripeSource().toNormalized(piEvent({ amount: 4000, amount_received: 4000 }), ctx());

    const rule = matchTagRouting(n.order, [
      { tag_name: "stripe:amount:45.00", document_type: "invoice_receipt", series_name: "BOOKLY", finalize_mode: "draft" },
    ]);

    expect(rule).toBeNull();
  });

  it("requires every part of a rule that names more than one condition", async () => {
    // Price AND origin: a hand-written Stripe invoice for the same 45.00 € is
    // not a booking, and this is what keeps it out of the bookings' series.
    stubStripe([]);
    const fromPlugin: any = await new StripeSource().toNormalized(piEvent(), ctx());
    stubStripe([session({ amount_total: 4500 })]);
    const fromCheckout: any = await new StripeSource().toNormalized(piEvent(), ctx());

    const rules = [
      { tag_name: "stripe:origin:api + stripe:amount:45.00", document_type: "invoice_receipt", series_name: "BOOKLY", finalize_mode: "draft" },
    ];

    expect(matchTagRouting(fromPlugin.order, rules)?.series_name).toBe("BOOKLY");
    expect(matchTagRouting(fromCheckout.order, rules)).toBeNull();
  });

  it("routes a rule written against a hint", async () => {
    stubStripe([]);
    const n: any = await new StripeSource().toNormalized(piEvent(), ctx());

    const rule = matchTagRouting(n.order, [
      { tag_name: "stripe:origin:api", document_type: "invoice_receipt", series_name: "BOOKLY", finalize_mode: "draft" },
    ]);

    expect(rule?.series_name).toBe("BOOKLY");
  });
});

describe("buildStripeRoutingHints", () => {
  it("emits nothing for a value Stripe left empty", () => {
    expect(buildStripeRoutingHints([{ description: "   ", statement_descriptor: null }], null)).toEqual([]);
  });

  it("lowercases so a rule does not depend on Stripe's capitalisation", () => {
    expect(buildStripeRoutingHints([{ description: "Bookly Appointment" }], null))
      .toEqual(["stripe:description:bookly appointment"]);
  });

  it("says each thing once across the objects of one payment", () => {
    const hints = buildStripeRoutingHints(
      [{ payment_method_types: ["card"] }, { payment_method_details: { type: "card" } }],
      "api",
    );
    expect(hints).toEqual(["stripe:origin:api", "stripe:payment_method:card"]);
  });
});
