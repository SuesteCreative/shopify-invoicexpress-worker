/**
 * Stripe moved two fields on invoice lines, and both moves were silent.
 *
 * Up to the 2024 API versions a line carried `price` and `tax_amounts`. From
 * the 2025 ones — measured live against 2026-04-22.dahlia on 04/09/2026 — it
 * carries `pricing.price_details.price` and `taxes`, and the old names are
 * simply absent.
 *
 * Neither absence looks like an error. The line still maps, with no price id
 * and no VAT: the Moloni and Vendus adapters read "no SKU and no product id" as
 * a shipping line, so a real sale was invoiced to the buyer as "Portes de envio
 * — <what they bought>", and a VAT-charged invoice would have been issued at 0%.
 */

import { describe, it, expect } from "vitest";
import { stripeToNormalized } from "./stripe-source";

/** The 2025+ shape, copied from a live invoice. */
const modernLine = (over: Record<string, any> = {}) => ({
  id: "il_1UBvu7IvYVkiIIWUKPlvhZWn",
  description: "Teste assinatura 1€",
  amount: 100,
  quantity: 1,
  currency: "eur",
  discount_amounts: [],
  taxes: [],
  pricing: {
    type: "price_details",
    unit_amount_decimal: "100",
    price_details: { price: "price_1UBvu7IvYVkiIIWUwiOx0R5Q", product: "prod_UlhTNhD7iUZu6m" },
  },
  ...over,
});

/** The pre-2025 shape, which existing connections still receive. */
const legacyLine = (over: Record<string, any> = {}) => ({
  id: "il_legacy",
  description: "Consulta",
  amount: 100,
  quantity: 1,
  currency: "eur",
  discount_amounts: [],
  tax_amounts: [],
  price: { id: "price_legacy" },
  ...over,
});

const invoiceEvent = (line: any) => ({
  type: "invoice.paid",
  data: {
    object: {
      id: "in_1UBvtOIvYVkiIIWUGJgrHHtK",
      object: "invoice",
      status: "paid",
      currency: "eur",
      created: 1_788_523_610,
      amount_paid: line.amount,
      total: line.amount,
      customer_name: "Maria João Tarouca",
      customer_email: "mj@example.pt",
      status_transitions: { paid_at: 1_788_523_753 },
      lines: { data: [line] },
    },
  },
});

const item = (event: any) => (stripeToNormalized(event) as any).order.items[0];

describe("invoice lines, across both Stripe shapes", () => {
  it("carries the price id from the 2025 shape", () => {
    // Empty here is what made a paid consultation read as postage.
    expect(item(invoiceEvent(modernLine())).sku).toBe("price_1UBvu7IvYVkiIIWUwiOx0R5Q");
  });

  it("still carries it from the older shape", () => {
    expect(item(invoiceEvent(legacyLine())).sku).toBe("price_legacy");
  });

  it("reads VAT off `taxes` on the 2025 shape", () => {
    const line = modernLine({ amount: 123, taxes: [{ amount: 23, tax_behavior: "exclusive" }] });
    const it0 = item(invoiceEvent(line));
    expect(it0.tax.unit_amount).toBeCloseTo(0.23, 2);
    expect(it0.tax.value).toBeCloseTo(18.7, 1);
  });

  it("takes an inclusive rate out of the net, whichever word Stripe used", () => {
    const modern = item(invoiceEvent(modernLine({ amount: 123, taxes: [{ amount: 23, tax_behavior: "inclusive" }] })));
    const legacy = item(invoiceEvent(legacyLine({ amount: 123, tax_amounts: [{ amount: 23, inclusive: true }] })));

    // 1.23 paid, 0.23 of it VAT: the net is 1.00 either way.
    expect(modern.unit_price).toBeCloseTo(1, 2);
    expect(legacy.unit_price).toBeCloseTo(1, 2);
  });

  it("still reads VAT off `tax_amounts` on the older shape", () => {
    const it0 = item(invoiceEvent(legacyLine({ amount: 123, tax_amounts: [{ amount: 23, inclusive: false }] })));
    expect(it0.tax.unit_amount).toBeCloseTo(0.23, 2);
  });
});
