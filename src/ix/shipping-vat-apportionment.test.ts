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

  it("splits a multi-rate shipping line and keeps the cents ON the taxed bands", () => {
    // The original F-SHIP case: two positive rates whose bases fall a couple of
    // cents short of the line total. Those cents used to vanish, which left the
    // document short and unbillable (Angel #4799) — so they were given a 0%
    // sub-line of their own.
    //
    // They are now absorbed back into the taxed bands instead. The money still
    // has to land (the second assertion below is the same one it always was),
    // but a 0% band is a FISCAL CLAIM, not a rounding bucket: one is enough for
    // shouldRequestTaxExemptionReason to stamp the shop's exemption code on the
    // whole document. Angel #4970 went to a Spanish CONSUMER declaring M05, the
    // export article, on the strength of five cents of rounding.
    const twoRates = [{ rate: 0.21, price: "1.57" }, { rate: 0.10, price: "0.45" }];
    const raw = mixedRateOrder(twoRates);
    raw.shipping_lines[0].price = "12.00";
    const items = new IxBuilder(shopConfig()).buildInvoiceItemsFromRaw(raw) as any[];
    const shipping = items.filter(i => i.name.startsWith("Portes de envio"));
    expect(shipping.map(i => i.tax)).toEqual([21, 10]);
    const net = (i: any) => i.unit_price * i.quantity * (1 - (i.discount ?? 0) / 100);
    expect(shipping.reduce((s, i) => s + net(i), 0)).toBeCloseTo(12, 2);
  });

  it("still publishes a 0% band when the shipping really is part untaxed", () => {
    // The bound is what the bands' own rounding can explain: half a cent of tax
    // divided by the rate. Here 21% collects 1.05 (basis 5.00) on a 12,00 line,
    // so seven euros of it carried no tax at all — that is a real untaxed
    // portion and it belongs on the document.
    const raw = mixedRateOrder([{ rate: 0.21, price: "1.05" }]);
    raw.shipping_lines[0].price = "12.00";
    const items = new IxBuilder(shopConfig()).buildInvoiceItemsFromRaw(raw) as any[];
    const shipping = items.filter(i => i.name.startsWith("Portes de envio"));
    expect(shipping.map(i => i.tax)).toEqual([21, 0]);
    const net = (i: any) => i.unit_price * i.quantity * (1 - (i.discount ?? 0) / 100);
    expect(shipping.reduce((s, i) => s + net(i), 0)).toBeCloseTo(12, 2);
  });

  it("does not split when the merchant forces a shipping rate", () => {
    const items = new IxBuilder(shopConfig({ force_shipping_tax_rate: 23 }))
      .buildInvoiceItemsFromRaw(mixedRateOrder(apportioned)) as any[];
    expect(items.filter(i => i.name.startsWith("Portes de envio"))).toHaveLength(1);
  });

  // The refund path matches a returned article to its invoice line BY POSITION,
  // using this trace. Shipping that splits into several lines from ONE source
  // line is the only place that alignment could slip — and a slip attaches a
  // refund to the wrong article at the wrong rate.
  it("traces every emitted line back to the order line that produced it", () => {
    const raw = mixedRateOrder([{ rate: 0.21, price: "1.05" }]);
    raw.shipping_lines[0].price = "12.00";
    raw.shipping_lines[0].id = 55501;
    raw.line_items[0].id = 900;
    raw.line_items[1].id = 901;
    const trace: any[] = [];
    const items = new IxBuilder(shopConfig()).buildInvoiceItemsFromRaw(raw, { trace }) as any[];

    expect(trace).toHaveLength(items.length);
    items.forEach((item, i) => {
      const isShipping = String(item.name).startsWith("Portes de envio");
      expect(trace[i].kind).toBe(isShipping ? "shipping" : "line");
      expect(trace[i].id).toBe(isShipping ? 55501 : (i === 0 ? 900 : 901));
    });
    // Two shipping lines out of one source line, both pointing at it.
    expect(trace.filter(t => t.kind === "shipping")).toHaveLength(2);
  });
});

describe("a shipping line removed by an order edit is not billed", () => {
  // Estrela #1292: the buyer switched from "BATCH - Spain" (2,49 €) to "BATCH -
  // Espanha Ilhas" (4,95 €) and paid the difference by hand. Shopify keeps the
  // old line in `shipping_lines` with `is_removed: true`; the invoice billed both
  // and came out 2,49 € above what was collected.
  it("leaves the replaced method off the invoice", () => {
    const raw = mixedRateOrder([{ rate: 0.23, price: "0.92" }]);
    raw.taxes_included = true;
    raw.total_price = "69.95";
    raw.total_tax = "13.07";
    raw.line_items = [{ title: "LUNA Birthstone Necklace", price: "65.00", quantity: 1, tax_lines: [{ rate: 0.23, price: "12.15" }] }];
    raw.shipping_lines = [
      { id: 1, title: "BATCH - Spain", price: "2.49", is_removed: true, tax_lines: [{ rate: 0.23, price: "0.46" }] },
      { id: 2, title: "BATCH - Espanha Ilhas", price: "4.95", is_removed: false, tax_lines: [{ rate: 0.23, price: "0.92" }] },
    ];
    const builder = new IxBuilder(shopConfig({ vat_included: 1 }));
    const items = builder.buildInvoiceItemsFromRaw(raw) as any[];
    expect(items.some(i => String(i.name).includes("BATCH - Spain"))).toBe(false);
    expect(items.some(i => String(i.name).includes("Espanha Ilhas"))).toBe(true);
    expect(builder.computeIxExpectedTotal(items)).toBeCloseTo(69.95, 2);
  });
});
