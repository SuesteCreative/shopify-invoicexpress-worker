import { describe, it, expect } from "vitest";
import { stripeToNormalized } from "./stripe-source";
import { computeExpectedGross, reconcileTotalOrThrow } from "../reconcile";

// A rate is not just a number that makes the total come out right — it has to be
// a rate the invoicer actually holds. Stripe reports tax rounded to the cent, so
// dividing it back by the net lands slightly beside the real rate: 18.22 on 79.20
// is 23.0051%, 8.05 on 35.02 is 22.98%. Carried at two decimals those reached
// InvoiceXpress as 23.01% and 22.98% lines, and that account holds IVA23 at 23.0
// with nothing beside it, so the line had no tax to match.
//
// Every EU VAT rate has at most one decimal (23, 22, 16, 13.5, 6, 4.8), which is
// where these numbers get rounded. The cases below are taken from real invoices
// on the account that surfaced this.

const toLines = (n: any) =>
  n.order.items.map((it: any) => ({
    name: it.title,
    quantity: Number(it.quantity),
    unit_price: Number(it.unit_price),
    tax_rate: Number(it.tax?.value ?? 0),
    discount_percent: Number(it.discount?.percent ?? 0),
  }));

const normalize = (event: any) => {
  const n = stripeToNormalized(event);
  if (!n) throw new Error("event did not normalize");
  return n;
};

const invoice = (line: any, over: any = {}) => ({
  type: "invoice.paid",
  data: {
    object: {
      id: "in_1U6SZKHtFLuAcUr8mrvdSOQh",
      object: "invoice",
      number: "INV-0100",
      status: "paid",
      currency: "eur",
      created: 1_756_000_000,
      customer_email: "buyer@example.pt",
      customer_name: "Buyer",
      lines: { data: [line] },
      ...over,
    },
  },
});

describe("Stripe VAT rate derivation", () => {
  it("gives 23%, not 23.01%, when the cent-rounded tax implies 23.0051%", () => {
    // Real shape: 99.00 line, 19.80 coupon, 18.22 tax collected on the 79.20 net.
    const n = normalize(invoice(
      {
        amount: 9900,
        quantity: 1,
        description: "1 x Start (at EUR 99.00 / month)",
        discount_amounts: [{ amount: 1980 }],
        tax_amounts: [{ amount: 1822, inclusive: false }],
      },
      { amount_paid: 9742, total: 9742 },
    ));

    expect(n.order.items[0].tax.value).toBe(23);
    expect(computeExpectedGross(toLines(n))).toBeCloseTo(97.42, 2);
    expect(() => reconcileTotalOrThrow(97.42, toLines(n), {})).not.toThrow();
  });

  it("gives 23% for a tax-inclusive line whose implied rate is 22.98%", () => {
    // Real shape: 35.00 charged inclusive of 6.54 VAT. 35.00 gross at 23% wants a
    // net of 28.4552, which no 2dp unit price reproduces — so the line has to be
    // re-targeted rather than left a cent wrong.
    const n = normalize(invoice(
      {
        amount: 3500,
        quantity: 1,
        description: "1 x Start",
        tax_amounts: [{ amount: 654, inclusive: true }],
      },
      { amount_paid: 3500, total: 3500 },
    ));

    expect(n.order.items[0].tax.value).toBe(23);
    expect(computeExpectedGross(toLines(n))).toBeCloseTo(35.0, 2);
    expect(() => reconcileTotalOrThrow(35.0, toLines(n), {})).not.toThrow();
  });

  it("leaves a line alone when the unit price already lands on the cent", () => {
    // No re-target discount should appear on the overwhelming majority of lines.
    const n = normalize(invoice(
      {
        amount: 10000,
        quantity: 1,
        description: "Clean 23%",
        tax_amounts: [{ amount: 2300, inclusive: false }],
      },
      { amount_paid: 12300, total: 12300 },
    ));

    expect(n.order.items[0].tax.value).toBe(23);
    expect(n.order.items[0].unit_price).toBe(100);
    expect(n.order.items[0].discount.percent).toBe(0);
    expect(() => reconcileTotalOrThrow(123, toLines(n), {})).not.toThrow();
  });

  it("keeps a genuine one-decimal rate instead of flattening it", () => {
    // 13.5% is a real rate (IE). Rounding to whole numbers would destroy it.
    const n = normalize(invoice(
      {
        amount: 20000,
        quantity: 1,
        description: "Irish reduced",
        tax_amounts: [{ amount: 2700, inclusive: false }],
      },
      { amount_paid: 22700, total: 22700 },
    ));

    expect(n.order.items[0].tax.value).toBe(13.5);
    expect(() => reconcileTotalOrThrow(227, toLines(n), {})).not.toThrow();
  });

  it("keeps the Madeira rate distinct from the mainland one", () => {
    const n = normalize(invoice(
      {
        amount: 10000,
        quantity: 1,
        description: "Madeira",
        tax_amounts: [{ amount: 2200, inclusive: false }],
      },
      { amount_paid: 12200, total: 12200 },
    ));

    expect(n.order.items[0].tax.value).toBe(22);
    expect(() => reconcileTotalOrThrow(122, toLines(n), {})).not.toThrow();
  });

  it("derives the Checkout rate the same way", () => {
    const n = normalize({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_live_b12RGCjbdxmKalGqtwrdEZYAUH5EEmQpzLhpLzSEXREuQRgOMd5Hrn15eT",
          object: "checkout.session",
          payment_status: "paid",
          payment_intent: "pi_3U6SZKHtFLuAcUr80mVQxLmN",
          currency: "eur",
          created: 1_756_000_000,
          customer_details: { name: "Buyer", email: "buyer@example.pt" },
          amount_subtotal: 9900,
          amount_total: 9742,
          total_details: { amount_discount: 1980, amount_tax: 1822, amount_shipping: 0 },
        },
      },
    });

    expect(n.order.items[0].tax.value).toBe(23);
    expect(() => reconcileTotalOrThrow(97.42, toLines(n), {})).not.toThrow();
  });
});
