/**
 * The other half of the per-sale classification: what `IxBuilder` does with it.
 *
 * Two properties matter more than the code that gets stamped, and both are
 * pinned here. First, the classification must not reach a document that has no
 * exempt line — stamping an exemption on a fully taxed sale declares a regime
 * the sale was not made under, which is the M99 class of drift in reverse.
 * Second, it must never move money: unlike the Shopify reverse-charge path,
 * which rebuilds the lines at zero because Shopify collected nothing, Stripe
 * Tax has already decided the amount and the invoice has to agree with what the
 * buyer paid.
 *
 * The third test is the one the merchant asked for: with no classification
 * passed, the build is byte-for-byte what it was before this existed.
 */

import { describe, it, expect } from "vitest";
import { IxBuilder } from "./builder";

const shopConfig = (extra: any = {}): any => ({
  user_id: "u1",
  shopify_domain: null,
  ix_document_type: "invoice_receipt",
  vat_included: 1,
  oss_enabled: 1,
  b2b_reverse_charge: 0,
  pos_mode: 0,
  auto_finalize: 1,
  ix_exemption_reason: "M10",
  ix_b2b_exemption_reason: "M16",
  ix_stamp_exemption_note: 0,
  force_tax_rate: null,
  force_shipping_tax_rate: null,
  ...extra,
});

/** A Stripe-shaped Normalized order: no raw_order, one line, tax on the line. */
const stripeOrder = (unitPrice: number, taxRate: number, over: any = {}): any => ({
  order: {
    id: 4242,
    order_number: 0,
    created_at: "2026-09-04T10:00:00Z",
    note: null,
    note_attributes: [],
    total: Math.round(unitPrice * (1 + taxRate / 100) * 100) / 100,
    customer: { name: "Hans Gruber", email: "hans@example.de" },
    billing_address: { name: "Hans Gruber", country_code: "DE", country: "Germany", company: "Nakatomi GmbH" },
    shipping_address: {},
    items: [{
      id: 1,
      quantity: 1,
      unit_price: unitPrice,
      tax: { name: "VAT", value: taxRate, unit_amount: taxRate === 0 ? 0 : 1 },
      discount: { name: "", percent: 0 },
      title: "Consulting",
      variant_title: null,
      sku: "CONS-1",
    }],
    global_discount: { name: "", percent: 0, amount: 0 },
    ...over,
  },
});

const build = (config: any, order: any, fiscal?: any) =>
  new IxBuilder(config).createInvoiceFromNormalizedOrder(order, fiscal ? { fiscal } : undefined);

describe("IxBuilder with a per-sale fiscal classification", () => {
  it("stamps the classified code and its legal mention on an exempt document", () => {
    const { invoice, requestTaxExemptionReason } = build(
      shopConfig(),
      stripeOrder(100, 0),
      { exemptionCode: "M16", mention: "Isento ao abrigo do art.º 14.º do RITI (DE811569869)" },
    );

    expect(requestTaxExemptionReason).toBe(true);
    expect(invoice.tax_exemption_reason).toBe("M16");
    expect(invoice.observations).toMatch(/RITI/);
    expect(invoice.observations).toMatch(/DE811569869/);
  });

  it("states the reason without waiting for ix_stamp_exemption_note", () => {
    // The opt-in flag governs the shop-wide path, where the mention is a
    // convenience. A classified document names its article because that is the
    // whole point of classifying it.
    const { invoice } = build(
      shopConfig({ ix_stamp_exemption_note: 0 }),
      stripeOrder(80, 0),
      { exemptionCode: "M05", mention: "Isento de IVA ao abrigo do art.º 14.º do CIVA" },
    );

    expect(invoice.observations).toMatch(/art\.º 14\.º do CIVA/);
  });

  it("refuses to put an exemption on a document that has no exempt line", () => {
    const { invoice, requestTaxExemptionReason } = build(
      shopConfig(),
      stripeOrder(100, 23),
      { exemptionCode: "M05", mention: "Isento de IVA ao abrigo do art.º 14.º do CIVA" },
    );

    expect(requestTaxExemptionReason).toBe(false);
    expect(invoice.tax_exemption_reason).toBeUndefined();
    expect(invoice.observations ?? "").not.toMatch(/CIVA/);
  });

  it("never moves money: a buyer who paid VAT is invoiced for what they paid", () => {
    const { invoice } = build(
      shopConfig(),
      stripeOrder(100, 23),
      { exemptionCode: "M16", mention: "qualquer coisa" },
    );

    expect(invoice.items).toHaveLength(1);
    expect(invoice.items[0].unit_price).toBeCloseTo(100, 2);
    const tax = invoice.items[0].tax;
    expect(typeof tax === "number" ? tax : tax.value).toBe(23);
  });

  it("without a classification, builds exactly what it built before", () => {
    const { invoice } = build(shopConfig(), stripeOrder(50, 0));

    expect(invoice.tax_exemption_reason).toBe("M10");
    // ix_stamp_exemption_note is 0, so no mention — the pre-existing behaviour.
    expect(invoice.observations).toBeUndefined();
  });

  it("still honours ix_stamp_exemption_note on the shop-wide path", () => {
    const { invoice } = build(shopConfig({ ix_exemption_reason: "M05", ix_stamp_exemption_note: 1 }), stripeOrder(50, 0));

    expect(invoice.tax_exemption_reason).toBe("M05");
    expect(invoice.observations).toMatch(/art\.º 14\.º do CIVA/);
  });

  it("keeps the merchant's standing note after the fiscal mention, so the 200-char cap eats the right one", () => {
    const { invoice } = build(
      shopConfig({ custom_invoice_note: "Licença 12345" }),
      stripeOrder(50, 0),
      { exemptionCode: "M05", mention: "Isento de IVA ao abrigo do art.º 14.º do CIVA" },
    );

    const obs = String(invoice.observations);
    expect(obs.indexOf("CIVA")).toBeLessThan(obs.indexOf("Licença"));
  });
});
