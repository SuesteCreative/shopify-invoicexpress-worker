import { describe, it, expect, vi, afterEach } from "vitest";
import { StripeSource } from "./stripe-source";
import type { AdapterCtx } from "../types";

// `amount_paid` is the money Stripe watched arrive. For an invoice the merchant
// marked as paid OUTSIDE Stripe it is 0 — not null, zero — so the `??` chain
// reading it stops there instead of falling through to `total`, and the sale
// arrives worth nothing. Five of Bestisafil's September sales, 905,23 €, were
// skipped as "total de valor zero" while the re-emit reported success.
const invoiceEvent = (over: Record<string, any> = {}) => ({
  type: "invoice.paid",
  data: {
    object: {
      id: "in_1UAg0yBTTqGjulMGZgoy0Al9",
      object: "invoice",
      number: "LLJCSSOJ-0265",
      currency: "eur",
      created: 1_788_307_200,
      status: "paid",
      paid: true,
      paid_out_of_band: true,
      amount_paid: 0,
      total: 13578,
      customer_name: "Alexandre Paulo dos Santos Almeida",
      customer_email: "a@example.pt",
      customer_address: { line1: "", city: "", postal_code: "", country: "PT" },
      lines: { data: [{ amount: 13578, quantity: 1, description: "Box de 6,5 m²" }] },
      ...over,
    },
  },
});

const ctxWith = (extra: Record<string, unknown> = {}) =>
  ({ sourceConfig: {}, config: { ...extra } } as unknown as AdapterCtx);

// No credentials in sourceConfig, so no enrichment call should fire; stubbed
// anyway so a regression there fails loudly instead of hitting the network.
afterEach(() => vi.unstubAllGlobals());
vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in this test"); }));

describe("an invoice paid outside Stripe", () => {
  it("is billed at the invoice total, not at the zero Stripe saw", async () => {
    const n = (await new StripeSource().toNormalized(invoiceEvent(), ctxWith({ stripe_invoice_out_of_band: 1 })))!;

    expect(n.order.total).toBe(135.78);
    expect(n.order.total_calculated).toBe(135.78);
  });

  it("stays worth nothing for a connection that did not declare the flag", async () => {
    const n = (await new StripeSource().toNormalized(invoiceEvent(), ctxWith()))!;

    expect(n.order.total).toBe(0);
  });

  // A real 0,00 € invoice reports `paid_out_of_band: false` and must keep being
  // skipped: there is no value and no tax to document.
  it("leaves a genuinely zero invoice at zero", async () => {
    const n = (await new StripeSource().toNormalized(
      invoiceEvent({ paid_out_of_band: false, total: 0, lines: { data: [{ amount: 0, quantity: 1 }] } }),
      ctxWith({ stripe_invoice_out_of_band: 1 },
    )))!;

    expect(n.order.total).toBe(0);
  });

  // Where Stripe DID watch money arrive, `amount_paid` is the truth — a part
  // payment must not be rounded up to the whole invoice.
  it("keeps amount_paid when the money went through Stripe", async () => {
    const n = (await new StripeSource().toNormalized(
      invoiceEvent({ paid_out_of_band: false, amount_paid: 5000 }),
      ctxWith({ stripe_invoice_out_of_band: 1 }),
    ))!;

    expect(n.order.total).toBe(50);
  });
});
