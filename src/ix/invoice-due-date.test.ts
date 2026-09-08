import { describe, it, expect } from "vitest";
import { IxBuilder } from "./builder";
import { buildNormalizedFromRaw } from "./normalize-local";

/**
 * When the document says it has to be paid.
 *
 * For a sale already paid the answer is "today" and nobody looks. For a
 * wholesale order on 30-day terms the due date is the entire point of the
 * document — and it used to be the order date regardless, so every invoice on
 * terms went out reading as due on the spot.
 */

const config = (extra: any = {}): any => ({
  user_id: "u1", shopify_domain: "shop.myshopify.com", ix_document_type: "invoice",
  vat_included: 1, oss_enabled: 0, b2b_reverse_charge: 0, pos_mode: 0, auto_finalize: 1,
  ix_exemption_reason: "M99", force_tax_rate: null, force_shipping_tax_rate: null,
  ix_payment_term: 0,
  ...extra,
});

const rawOrder = (extra: any = {}): any => ({
  id: 42, order_number: 1071, name: "#1071", currency: "EUR", total_price: "22.19",
  taxes_included: true, created_at: "2026-09-08T10:46:28Z",
  line_items: [{ title: "Electrolyte Drink", sku: "SAVA-1", price: "22.19", quantity: 1, taxable: true, tax_lines: [{ rate: 0.23 }] }],
  shipping_lines: [], customer: {}, billing_address: {}, shipping_address: {},
  ...extra,
});

const dueDateFor = (cfg: any, raw: any) => {
  const { normalized } = buildNormalizedFromRaw(raw, "shop.myshopify.com");
  const quiet = console.log; console.log = () => {};
  try {
    return (new IxBuilder(cfg).createInvoiceFromNormalizedOrder(normalized).invoice as any).due_date;
  } finally {
    console.log = quiet;
  }
};

describe("invoice due date", () => {
  it("uses the payment terms Shopify carries for that order", () => {
    const raw = rawOrder({
      payment_terms: {
        payment_terms_name: "Net 30",
        payment_schedules: [{ due_at: "2026-10-08T10:46:28Z", amount: "22.19" }],
      },
    });
    expect(dueDateFor(config(), raw)).toBe("2026-10-08T10:46:28Z");
  });

  it("falls back to the shop's own term when the order carries none", () => {
    expect(dueDateFor(config({ ix_payment_term: 30 }), rawOrder()))
      .toBe(new Date("2026-10-08T10:46:28Z").toISOString());
  });

  // The default, and what every existing shop is on: due the day it is issued.
  it("is the order date when there are no terms anywhere", () => {
    expect(dueDateFor(config(), rawOrder())).toBe("2026-09-08T10:46:28Z");
  });

  it("prefers the order's own terms over the shop default", () => {
    const raw = rawOrder({ payment_terms: { payment_schedules: [{ due_at: "2026-11-07T10:46:28Z" }] } });
    expect(dueDateFor(config({ ix_payment_term: 30 }), raw)).toBe("2026-11-07T10:46:28Z");
  });

  // A malformed date must not become an invoice due on "Invalid Date".
  it("ignores an unparseable due_at and uses the fallback", () => {
    const raw = rawOrder({ payment_terms: { payment_schedules: [{ due_at: "later, maybe" }] } });
    expect(dueDateFor(config(), raw)).toBe("2026-09-08T10:46:28Z");
  });
});
