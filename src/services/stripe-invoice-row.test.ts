import { describe, it, expect } from "vitest";
import { toStripeInvoiceRow, toStripeRefundRow } from "./stripe";

/**
 * Flattening an invoice for reconciliation.
 *
 * The one piece of real logic is which PaymentIntent paid it, and Stripe answers
 * that in two different shapes depending on API version: on the object up to
 * 2024, and inside `payments` from 2025. An invoice settled outside Stripe
 * carries a payment_record AND an abandoned PaymentIntent, and keying on the
 * abandoned one files the sale under a payment that never happened.
 */
describe("toStripeInvoiceRow", () => {
  it("reads the PaymentIntent off the 2024 shape", () => {
    const row = toStripeInvoiceRow({ id: "in_1", number: "5W7EWHOS-2233", payment_intent: "pi_1", created: 1_767_225_600, total: 6900, amount_paid: 6900, currency: "eur", status: "paid" });
    expect(row.payment_intent).toBe("pi_1");
    expect(row.number).toBe("5W7EWHOS-2233");
    // Cents to euros, so the caller compares against a document total directly.
    expect(row.total).toBe(69);
    expect(row.created.slice(0, 10)).toBe("2026-01-01");
  });

  it("reads it out of `payments` on the 2025 shape", () => {
    const row = toStripeInvoiceRow({
      id: "in_2", number: "5W7EWHOS-2234",
      payments: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: "pi_2" } }] },
    });
    expect(row.payment_intent).toBe("pi_2");
  });

  it("refuses the abandoned PaymentIntent of an invoice paid outside Stripe", () => {
    const row = toStripeInvoiceRow({
      id: "in_3",
      payments: { data: [
        { status: "paid", payment: { type: "payment_record", payment_record: "pr_1" } },
        { status: "canceled", payment: { type: "payment_intent", payment_intent: "pi_abandonado" } },
      ] },
    });
    expect(row.payment_intent).toBeNull();
  });

  it("carries the buyer's identity, which the payment shapes do not have", () => {
    const row = toStripeInvoiceRow({
      id: "in_4", customer: "cus_1", customer_name: "Gonçalo Pereira",
      customer_email: "g@example.pt", customer_tax_ids: [{ type: "eu_vat", value: "PT518884597" }],
    });
    expect(row.customer).toBe("cus_1");
    expect(row.customer_name).toBe("Gonçalo Pereira");
    expect(row.customer_tax_id).toBe("PT518884597");
  });

  it("does not invent fields for a sparse invoice", () => {
    const row = toStripeInvoiceRow({ id: "in_5" });
    expect(row).toMatchObject({ number: null, payment_intent: null, customer_tax_id: null, total: 0, currency: "" });
  });
});

describe("toStripeRefundRow", () => {
  it("names the payment it reversed, expanded or not", () => {
    expect(toStripeRefundRow({ id: "re_1", payment_intent: "pi_1", charge: "ch_1", amount: 1500, currency: "eur", created: 1_767_225_600, status: "succeeded", reason: "requested_by_customer" }))
      .toMatchObject({ payment_intent: "pi_1", charge: "ch_1", amount: 15, currency: "EUR", status: "succeeded" });
    expect(toStripeRefundRow({ id: "re_2", payment_intent: { id: "pi_2" } }).payment_intent).toBe("pi_2");
  });

  it("keeps a partial refund at its own amount, not the charge total", () => {
    // The reason this list exists: charge.amount_refunded is a running total
    // with no date, so a partial reversal cannot be matched to a credit note.
    expect(toStripeRefundRow({ id: "re_3", charge: "ch_3", amount: 500 }).amount).toBe(5);
  });

  it("does not invent fields for a sparse refund", () => {
    expect(toStripeRefundRow({ id: "re_4" })).toMatchObject({ payment_intent: null, charge: null, amount: 0, status: null, reason: null });
  });
});
