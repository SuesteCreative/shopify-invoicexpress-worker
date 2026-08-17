import { describe, it, expect } from "vitest";
import { IxBuilder } from "./builder";

// Angel Piercing #4799, 258.30€, unbilled since 14/08/2026. A basket holding one
// 0%-rated article makes Shopify apportion the shipping VAT — the 25€ line comes
// back as tax_lines [23%: 5.46, 0%: 0.00], meaning only part of it is taxable.
// We stamped the whole 25€ at 23%, over-taxed it, and the reconcile guard refused
// the document. On a longer order the residual absorber hid the same error and
// the invoice went out with the VAT shifted onto another line instead.

const shopConfig = (extra: any = {}): any => ({
  user_id: "u1", shopify_domain: "2d0604-3.myshopify.com", ix_document_type: "invoice_receipt",
  vat_included: 0, oss_enabled: 1, b2b_reverse_charge: 0, pos_mode: 0, auto_finalize: 0,
  ix_exemption_reason: "M05", force_tax_rate: null, force_shipping_tax_rate: null,
  ...extra,
});

/** Tax-EXCLUDED order: one 23% article, one 0% article, apportioned shipping. */
const mixedRateOrder = (shipTaxLines: any[]): any => ({
  id: 13469899489666, order_number: 4799, currency: "EUR",
  taxes_included: false,
  // 100.00 + 9.50 + 25.00 net, + 23.00 + 5.25 VAT
  total_price: "162.75", total_tax: "28.25", total_discounts: "0.00",
  billing_address: { country_code: "BR", country: "Brazil" },
  line_items: [
    { title: "Expositor Luxo", price: "100.00", quantity: 1, tax_lines: [{ rate: 0.23, price: "23.00" }] },
    { title: "Artigo isento", price: "9.50", quantity: 1, tax_lines: [{ rate: 0, price: "0.00" }] },
  ],
  shipping_lines: [{ title: "CTT", price: "25.00", tax_lines: shipTaxLines }],
});

const asNormalized = (raw: any): any => ({
  order: {
    id: raw.id, order_number: raw.order_number, created_at: "2026-08-14T12:55:00Z",
    customer: {}, billing_address: raw.billing_address, shipping_address: {},
    note: null, note_attributes: [], items: [],
  },
  raw_order: raw,
});

describe("shipping VAT is only charged on the part Shopify taxed", () => {
  const apportioned = [{ rate: 0.23, price: "5.25" }, { rate: 0, price: "0.00" }];

  it("totals exactly what the customer paid", () => {
    const builder = new IxBuilder(shopConfig());
    const items = builder.buildInvoiceItemsFromRaw(mixedRateOrder(apportioned));
    expect(builder.computeIxExpectedTotal(items)).toBeCloseTo(162.75, 2);
  });

  it("splits the shipping into its taxed and untaxed portions", () => {
    const items = new IxBuilder(shopConfig()).buildInvoiceItemsFromRaw(mixedRateOrder(apportioned)) as any[];
    const shipping = items.filter(i => i.name.startsWith("Portes de envio"));
    expect(shipping.map(i => i.tax)).toEqual([23, 0]);
    // 5.25 / 0.23 = 22.8261 taxable, the remaining 2.1739 untaxed.
    const net = (i: any) => i.unit_price * i.quantity * (1 - (i.discount ?? 0) / 100);
    expect(net(shipping[0])).toBeCloseTo(22.8261, 3);
    expect(net(shipping[1])).toBeCloseTo(2.1739, 3);
    expect(net(shipping[0]) + net(shipping[1])).toBeCloseTo(25, 2);
  });

  it("lets the order through the reconcile guard that was refusing it", () => {
    const builder = new IxBuilder(shopConfig());
    expect(() => builder.createInvoiceFromNormalizedOrder(asNormalized(mixedRateOrder(apportioned)))).not.toThrow();
  });

  it("reads the rate off the tax line that collected, not the first one", () => {
    // Shopify orders tax_lines by rate, so the 0% band can come first. Reading
    // tax_lines[0] made the whole shipping untaxed.
    const zeroFirst = [{ rate: 0, price: "0.00" }, { rate: 0.23, price: "5.25" }];
    const builder = new IxBuilder(shopConfig());
    const items = builder.buildInvoiceItemsFromRaw(mixedRateOrder(zeroFirst)) as any[];
    expect(items.filter(i => i.name.startsWith("Portes de envio")).map(i => i.tax)).toEqual([23, 0]);
    expect(builder.computeIxExpectedTotal(items)).toBeCloseTo(162.75, 2);
  });

  it("leaves fully taxed shipping as a single line", () => {
    const fullyTaxed = [{ rate: 0.23, price: "5.75" }];
    const raw = mixedRateOrder(fullyTaxed);
    raw.line_items[1].tax_lines = [{ rate: 0.23, price: "2.19" }];
    raw.total_tax = "30.94"; raw.total_price = "165.44";
    const items = new IxBuilder(shopConfig()).buildInvoiceItemsFromRaw(raw) as any[];
    const shipping = items.filter(i => i.name.startsWith("Portes de envio"));
    expect(shipping).toHaveLength(1);
    expect(shipping[0].name).toBe("Portes de envio — CTT");
  });

  it("still splits a genuinely multi-rate shipping line, and keeps the remainder", () => {
    // The original F-SHIP case: two positive rates, whose bases fall a couple of
    // cents short of the line total. Those cents used to vanish.
    const twoRates = [{ rate: 0.21, price: "1.57" }, { rate: 0.10, price: "0.45" }];
    const raw = mixedRateOrder(twoRates);
    raw.shipping_lines[0].price = "12.00";
    const items = new IxBuilder(shopConfig()).buildInvoiceItemsFromRaw(raw) as any[];
    const shipping = items.filter(i => i.name.startsWith("Portes de envio"));
    expect(shipping.map(i => i.tax)).toEqual([21, 10, 0]);
    const net = (i: any) => i.unit_price * i.quantity * (1 - (i.discount ?? 0) / 100);
    expect(shipping.reduce((s, i) => s + net(i), 0)).toBeCloseTo(12, 2);
  });

  it("does not split when the merchant forces a shipping rate", () => {
    const items = new IxBuilder(shopConfig({ force_shipping_tax_rate: 23 }))
      .buildInvoiceItemsFromRaw(mixedRateOrder(apportioned)) as any[];
    expect(items.filter(i => i.name.startsWith("Portes de envio"))).toHaveLength(1);
  });
});
