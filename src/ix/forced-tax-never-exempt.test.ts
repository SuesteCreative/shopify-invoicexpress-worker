import { describe, it, expect } from "vitest";
import { IxBuilder } from "./builder";
import { ixExpectedTotals } from "./create-invoice";
import { buildIxDatePutBody } from "../handlers/admin";

// Regression cover for the Zoo de Lagos incident of 2026-08-02→05: 81 ticket
// sales (place of supply PT, 6%, never exempt) were issued at 0% VAT, stamped
// with the shop's generic exemption code, each totalling less than the customer
// paid — and the nightly sweep then tried to restate the surviving documents.

const shopConfig = (extra: any = {}): any => ({
  user_id: "u1", shopify_domain: "zoo.myshopify.com", ix_document_type: "invoice_receipt",
  vat_included: 1, oss_enabled: 0, b2b_reverse_charge: 0, pos_mode: 0, auto_finalize: 1,
  ix_exemption_reason: "M99", force_tax_rate: 6, force_shipping_tax_rate: null,
  ...extra,
});

/** A ticket sale where Shopify itself collected no VAT — the shape that broke. */
const rawOrder = (lineExtra: any = {}): any => ({
  id: 1, order_number: 3525, currency: "EUR", total_price: "58.00", taxes_included: true,
  line_items: [
    { title: "Bilhete Adulto", sku: "ZL-ADT", price: "17.00", quantity: 2, taxable: true, tax_lines: [], ...lineExtra },
    { title: "Bilhete Criança", sku: "ZL-CRI", price: "12.00", quantity: 2, taxable: true, tax_lines: [] },
  ],
  shipping_lines: [],
});

describe("a forced rate is never turned into an exemption", () => {
  it("stamps the forced 6% on a sale Shopify did not tax", () => {
    const items = new IxBuilder(shopConfig()).buildInvoiceItemsFromRaw(rawOrder());
    expect(items).toHaveLength(2);
    for (const it of items as any[]) expect(it.tax).toBe(6);
    // Gross must still be what the customer paid: 58.00.
    expect(ixExpectedTotals(items as any[]).gross).toBeCloseTo(58, 2);
  });

  it("refuses to build a 0% line for a shop that forces a positive rate", () => {
    // force_tax_rate arriving as 0/absent is the failure we must not paper over.
    const builder = new IxBuilder(shopConfig());
    const items: any[] = builder.buildInvoiceItemsFromRaw(rawOrder()) as any[];
    items[0].tax = 0; // simulate a rate that got lost downstream
    expect(builder.shouldRequestTaxExemptionReason(items)).toBe(true);

    // …and the builder itself never produces one:
    const sneaky: any = new IxBuilder(shopConfig());
    expect(() => sneaky.assertForcedRateApplied(0, 6, "produto", "Bilhete Adulto"))
      .toThrow(/0% de IVA numa loja que impõe 6%/);
  });

  it("still allows a genuinely exempt shop to invoice at 0%", () => {
    const items = new IxBuilder(shopConfig({ force_tax_rate: 0, ix_exemption_reason: "M10" }))
      .buildInvoiceItemsFromRaw(rawOrder());
    for (const it of items as any[]) expect(it.tax).toBe(0);
  });

  it("still honours an explicit per-SKU 0% override", () => {
    const overrides = new Map<string, any>([["ZL-ADT", { tax_rate: 0 }]]);
    const items = new IxBuilder(shopConfig(), undefined, overrides as any).buildInvoiceItemsFromRaw(rawOrder());
    expect((items as any[])[0].tax).toBe(0);
    expect((items as any[])[1].tax).toBe(6);
  });
});

describe("moving a document's date never moves its money", () => {
  const accountTaxes = new Map([
    [1072450, { name: "IVA6", value: 6 }],
    [1047358, { name: "Isento", value: 0 }],
  ]);
  const doc = (items: any[], extra: any = {}): any => ({
    id: 99, status: "draft", date: "04/08/2026", due_date: "04/08/2026",
    reference: "Order #3525", observations: null, total: 58, taxes: 3.28, before_taxes: 54.72,
    client: { id: 7, name: "Ana", country: "Portugal" }, items, ...extra,
  });
  const line = (tax: any, unit_price = "16.04") => ({ name: "Bilhete", quantity: "2.0", unit_price, tax });

  it("restores a line whose rate came back null instead of zeroing it", () => {
    const body = buildIxDatePutBody(
      doc([line({ id: 1072450, name: null, value: null }), line({ id: 1072450, name: null, value: null }, "11.33")]),
      "invoice_receipt", "2026-08-09", "", { accountTaxes, exemptionReason: "M99" },
    );
    for (const it of body.data.items) expect(it.tax).toEqual({ id: 1072450, name: "IVA6", value: 6 });
    expect(body.data.tax_exemption_reason).toBeUndefined();
  });

  it("refuses when the line's tax cannot be resolved at all", () => {
    expect(() => buildIxDatePutBody(
      doc([line({ id: 999999, name: null, value: null })]),
      "invoice_receipt", "2026-08-09", "", { accountTaxes, exemptionReason: "M99" },
    )).toThrow(/Não consigo reler a taxa/);
  });

  it("refuses when the rebuild would not total what the document holds", () => {
    // The same lines read back at 0% would drop a whole 6% band: 58.00 → 54.74.
    expect(() => buildIxDatePutBody(
      doc([line({ id: 1047358, name: "Isento", value: 0 }), line({ id: 1047358, name: "Isento", value: 0 }, "11.33")], { total: 58 }),
      "invoice_receipt", "2026-08-09", "", { accountTaxes, exemptionReason: "M99" },
    )).toThrow(/não altero a data à custa do valor/);
  });

  it("tolerates the cents IX's 2dp read-back costs a faithful rebuild", () => {
    // 2×16.04 + 2×11.33 at 6% rebuilds to 58.02 against a stored 58.00.
    const body = buildIxDatePutBody(
      doc([line({ id: 1072450, name: "IVA6", value: 6 }), line({ id: 1072450, name: "IVA6", value: 6 }, "11.33")]),
      "invoice_receipt", "2026-08-09", "", { accountTaxes, exemptionReason: "M99" },
    );
    expect(body.data.date).toBe("2026-08-09");
    expect(body.data.due_date).toBe("2026-08-09");
  });

  it("carries the exemption reason for a genuinely exempt document", () => {
    const body = buildIxDatePutBody(
      doc([line({ id: 1047358, name: "Isento", value: 0 })], { total: 32.08, taxes: 0, before_taxes: 32.08 }),
      "invoice_receipt", "2026-08-09", "", { accountTaxes, exemptionReason: "M10" },
    );
    expect(body.data.tax_exemption_reason).toBe("M10");
  });
});

describe("ixExpectedTotals mirrors IX's round-once model", () => {
  it("rounds the summed gross once, not per line", () => {
    const { gross, vat } = ixExpectedTotals([
      { quantity: 2, unit_price: 16.0377, tax: 6 },
      { quantity: 2, unit_price: 11.3208, tax: 6 },
    ]);
    expect(gross).toBeCloseTo(58, 2);
    expect(vat).toBeCloseTo(3.28, 2);
  });

  it("counts the percentage discount, and ignores discount_amount as IX does", () => {
    expect(ixExpectedTotals([{ quantity: 1, unit_price: 100, tax: 23, discount: 10 }]).gross).toBeCloseTo(110.7, 2);
    // IX drops `discount_amount` on POST; predicting otherwise would condemn a
    // good document as mis-stored.
    expect(ixExpectedTotals([{ quantity: 1, unit_price: 100, tax: 0, discount_amount: 25 }]).gross).toBeCloseTo(100, 2);
  });
});