import { describe, it, expect } from "vitest";
import { stripeToNormalized } from "./stripe-source";
import { computeExpectedGross, reconcileTotalOrThrow } from "../reconcile";

// A merchant who runs promo codes had every discounted sale silently dropped.
//
// Stripe strikes `amount_subtotal` BEFORE discounts (and outside shipping), and
// an invoice line's `amount` before its `discount_amounts[]`. The mapper read
// both as if they were the final net, so the lines it emitted described a sale
// nobody made. The destinations reconcile line math against the amount actually
// paid within a cent (ix-destination.ts, moloni-destination.ts) — so the drift
// did not produce a wrong invoice, it produced NO invoice, and the merchant saw
// only silence.
//
// These tests hold the mapper to the one invariant that matters: the lines it
// emits must reproduce the amount the buyer actually paid.

const toReconcileLines = (n: any) =>
  n.order.items.map((it: any) => ({
    name: it.title,
    quantity: Number(it.quantity),
    unit_price: Number(it.unit_price),
    tax_rate: Number(it.tax?.value ?? 0),
    discount_percent: Number(it.discount?.percent ?? 0),
  }));

/** The gross the destinations will compute from the mapped lines. */
const grossOf = (n: any): number => computeExpectedGross(toReconcileLines(n));

/** Exactly what the destination adapters do before POSTing. */
const assertReconciles = (n: any) => {
  reconcileTotalOrThrow(Number(n.order.total), toReconcileLines(n), { context: "test" });
};

const normalize = (event: any) => {
  const n = stripeToNormalized(event);
  if (!n) throw new Error("event did not normalize");
  return n;
};

const session = (over: any = {}) => ({
  type: "checkout.session.completed",
  data: {
    object: {
      id: "cs_test_a1QeAKrOvTQdRk2yWXvIhBcJHPbmnRcNVUOnDdVoSGRUXvzKgQfNTKCJmH",
      object: "checkout.session",
      payment_status: "paid",
      payment_intent: "pi_3U3vtjJNp2FcbLOX1LzfGa73",
      currency: "eur",
      created: 1_755_000_000,
      customer_details: { name: "Ana Marques", email: "ana@example.pt" },
      ...over,
    },
  },
});

describe("Stripe Checkout: promo codes", () => {
  it("invoices the discounted total, not the pre-discount subtotal", () => {
    // 100.00 of goods, 20.00 coupon, 23% VAT on the remaining 80.00 = 18.40.
    const n = normalize(session({
      amount_subtotal: 10000,
      amount_total: 9840,
      total_details: { amount_discount: 2000, amount_tax: 1840, amount_shipping: 0 },
    }));

    expect(n.order.total).toBe(98.4);
    expect(grossOf(n)).toBeCloseTo(98.4, 2);
    expect(n.order.items[0].tax.value).toBe(23);
    // The pre-fix value: the subtotal, invoiced as if the coupon never happened.
    expect(n.order.items[0].unit_price).not.toBe(100);
    expect(() => assertReconciles(n)).not.toThrow();
  });

  it("still reconciles when the coupon leaves an odd net", () => {
    // 149.99 less a 33.33 coupon = 116.66 net, 23% VAT = 26.83, paid 143.49.
    const n = normalize(session({
      amount_subtotal: 14999,
      amount_total: 14349,
      total_details: { amount_discount: 3333, amount_tax: 2683, amount_shipping: 0 },
    }));

    expect(n.order.total).toBe(143.49);
    expect(() => assertReconciles(n)).not.toThrow();
  });

  it("counts shipping, which amount_subtotal excludes", () => {
    // 80.00 goods + 5.00 shipping = 85.00 net, 23% VAT = 19.55, paid 104.55.
    const n = normalize(session({
      amount_subtotal: 8000,
      amount_total: 10455,
      total_details: { amount_discount: 0, amount_tax: 1955, amount_shipping: 500 },
    }));

    expect(n.order.total).toBe(104.55);
    expect(() => assertReconciles(n)).not.toThrow();
  });

  it("does not drift past the 1 cent guard on a large discounted sale", () => {
    // A rate rounded to 2dp, multiplied back over a four-figure net, is where
    // naive net-and-rate mapping loses a cent.
    const n = normalize(session({
      amount_subtotal: 500000,
      amount_total: 393600,
      total_details: { amount_discount: 120000, amount_tax: 73600, amount_shipping: 0 },
    }));

    expect(n.order.total).toBe(3936);
    expect(Math.abs(grossOf(n) - 3936)).toBeLessThanOrEqual(0.01);
    expect(() => assertReconciles(n)).not.toThrow();
  });

  it("leaves an untaxed session on the gross, for the downstream default rate", () => {
    const n = normalize(session({
      amount_subtotal: 10000,
      amount_total: 8000,
      total_details: { amount_discount: 2000, amount_tax: 0, amount_shipping: 0 },
    }));

    expect(n.order.total).toBe(80);
    expect(n.order.items[0].unit_price).toBe(80);
    expect(n.order.items[0].tax.value).toBe(0);
  });
});

const invoice = (lines: any[], over: any = {}) => ({
  type: "invoice.paid",
  data: {
    object: {
      id: "in_1U3vtjJNp2FcbLOX8kQwMzTt",
      object: "invoice",
      number: "INV-0042",
      status: "paid",
      currency: "eur",
      created: 1_755_000_000,
      customer_email: "ana@example.pt",
      customer_name: "Ana Marques",
      lines: { data: lines },
      ...over,
    },
  },
});

describe("Stripe Invoice: subscription and invoice coupons", () => {
  it("takes the coupon off the line instead of overshooting amount_paid", () => {
    // One 100.00 line, 20.00 coupon, 23% VAT on the remaining 80.00 = 18.40.
    const n = normalize(invoice(
      [{
        amount: 10000,
        quantity: 1,
        description: "Subscricao mensal",
        discount_amounts: [{ amount: 2000, discount: "di_1U3vtjJNp2FcbLOX7hGkLpQr" }],
        tax_amounts: [{ amount: 1840, inclusive: false }],
        price: { id: "price_1U3vtjJNp2FcbLOX9aBcDeFg" },
      }],
      { amount_paid: 9840, total: 9840 },
    ));

    expect(n.order.total).toBe(98.4);
    expect(n.order.items[0].unit_price).toBeCloseTo(80, 2);
    expect(n.order.items[0].tax.value).toBe(23);
    expect(() => assertReconciles(n)).not.toThrow();
  });

  it("keeps each rate right when a coupon spreads over mixed-rate lines", () => {
    // 100.00 at 23% and 50.00 at 6%, each carrying its allocated 10% share.
    const n = normalize(invoice(
      [
        {
          amount: 10000,
          quantity: 1,
          description: "Servico",
          discount_amounts: [{ amount: 1000 }],
          tax_amounts: [{ amount: 2070, inclusive: false }],
        },
        {
          amount: 5000,
          quantity: 1,
          description: "Livro",
          discount_amounts: [{ amount: 500 }],
          tax_amounts: [{ amount: 270, inclusive: false }],
        },
      ],
      { amount_paid: 15840, total: 15840 },
    ));

    expect(n.order.items[0].tax.value).toBe(23);
    expect(n.order.items[1].tax.value).toBe(6);
    expect(n.order.total).toBe(158.4);
    expect(() => assertReconciles(n)).not.toThrow();
  });

  it("reads inclusive tax out of the line amount", () => {
    // 123.00 charged inclusive of 23% VAT, less a 12.30 coupon: paid 110.70,
    // of which 20.70 is VAT on a 90.00 net.
    const n = normalize(invoice(
      [{
        amount: 12300,
        quantity: 1,
        description: "Plano anual",
        discount_amounts: [{ amount: 1230 }],
        tax_amounts: [{ amount: 2070, inclusive: true }],
      }],
      { amount_paid: 11070, total: 11070 },
    ));

    expect(n.order.total).toBe(110.7);
    expect(n.order.items[0].tax.value).toBe(23);
    expect(() => assertReconciles(n)).not.toThrow();
  });

  it("spreads a discounted line over its quantity", () => {
    // 4 x 50.00 = 200.00, 40.00 coupon, 23% VAT on 160.00 = 36.80.
    const n = normalize(invoice(
      [{
        amount: 20000,
        quantity: 4,
        description: "Licenca",
        discount_amounts: [{ amount: 4000 }],
        tax_amounts: [{ amount: 3680, inclusive: false }],
      }],
      { amount_paid: 19680, total: 19680 },
    ));

    expect(n.order.items[0].quantity).toBe(4);
    expect(n.order.items[0].unit_price).toBeCloseTo(40, 2);
    expect(() => assertReconciles(n)).not.toThrow();
  });

  it("is unchanged for an invoice with no coupon at all", () => {
    const n = normalize(invoice(
      [{
        amount: 10000,
        quantity: 1,
        description: "Sem desconto",
        tax_amounts: [{ amount: 2300, inclusive: false }],
      }],
      { amount_paid: 12300, total: 12300 },
    ));

    expect(n.order.items[0].unit_price).toBe(100);
    expect(n.order.items[0].tax.value).toBe(23);
    expect(() => assertReconciles(n)).not.toThrow();
  });
});
