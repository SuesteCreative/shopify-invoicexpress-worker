import { describe, it, expect } from "vitest";
import { IxBuilder, nifHoldReason } from "./builder";

// Angel Piercing #4783, 325.55€, unbilled since 12/08/2026. The buyer put a
// French VAT number in the company field of an address that says Portugal. We
// stamped it as the client's fiscal_id anyway and InvoiceXpress refused the
// whole document with "Contribuinte não é válido" — no invoice, no email,
// nobody told. IX validates the pair, so there is nothing to guess: the draft
// plus a message to the merchant is the only honest outcome.

const shopConfig = (extra: any = {}): any => ({
  user_id: "u1", shopify_domain: "2d0604-3.myshopify.com", ix_document_type: "invoice_receipt",
  vat_included: 0, oss_enabled: 1, b2b_reverse_charge: 0, pos_mode: 0, auto_finalize: 0,
  ix_exemption_reason: "M05", force_tax_rate: null, force_shipping_tax_rate: null,
  ...extra,
});

const orderWith = (billing: any, extra: any = {}): any => {
  const raw = {
    id: 13463949246850, order_number: 4783, currency: "EUR", taxes_included: false,
    total_price: "100.00", total_tax: "0.00", total_discounts: "0.00",
    billing_address: billing,
    line_items: [{ title: "Peça", price: "100.00", quantity: 1, tax_lines: [{ rate: 0.23, price: "0.00" }] }],
    shipping_lines: [],
    ...extra,
  };
  return {
    order: {
      id: raw.id, order_number: raw.order_number, created_at: "2026-08-12T17:21:00Z",
      customer: { name: "Dany Tattoo" }, billing_address: billing, shipping_address: {},
      note: null, note_attributes: [], items: [],
    },
    raw_order: raw,
  };
};

describe("a VAT number that contradicts the address is never stamped", () => {
  const frenchVatOnPtAddress = orderWith({
    country_code: "PT", country: "Portugal", address1: "", city: "", company: "FR18898261615",
  });

  it("leaves the fiscal_id off instead of letting IX reject the document", () => {
    const client = new IxBuilder(shopConfig()).buildInvoiceClient(frenchVatOnPtAddress);
    expect(client.fiscal_id).toBeUndefined();
  });

  it("holds the build so the caller drafts it and writes to the merchant", () => {
    const { nifHold } = new IxBuilder(shopConfig()).createInvoiceFromNormalizedOrder(frenchVatOnPtAddress);
    expect(nifHold).toEqual({ kind: "country_mismatch", raw: "FR18898261615", billingCountry: "PT" });
    expect(nifHoldReason(nifHold!)).toBe('nif_country_mismatch: "FR18898261615" com morada em PT');
  });

  it("stamps it when the address agrees with the prefix", () => {
    const french = orderWith({
      country_code: "FR", country: "France", address1: "16 rue Émile Magnin", city: "Besançon",
      company: "FR18898261615",
    });
    const builder = new IxBuilder(shopConfig());
    expect(builder.buildInvoiceClient(french).fiscal_id).toBe("FR18898261615");
    expect(builder.createInvoiceFromNormalizedOrder(french).nifHold).toBeUndefined();
  });

  it("treats an unstated country as Portugal, so a PT number still goes through", () => {
    // 519227921 is a valid PT NIF; the EU fallback prefixes it and the client
    // builder unwraps it back to nine bare digits.
    const noCountry = orderWith({ country_code: "", country: "", company: "PT519227921" });
    const builder = new IxBuilder(shopConfig());
    expect(builder.buildInvoiceClient(noCountry).fiscal_id).toBe("519227921");
    expect(builder.createInvoiceFromNormalizedOrder(noCountry).nifHold).toBeUndefined();
  });

  it("does not hold a buyer whose own NIF is good, whatever else is lying around", () => {
    const good = orderWith(
      { country_code: "PT", country: "Portugal", company: "519227921", address1: "Rua A", city: "Lisboa" },
      { note: "encomenda para a FR18898261615" },
    );
    const builder = new IxBuilder(shopConfig());
    expect(builder.buildInvoiceClient(good).fiscal_id).toBe("519227921");
    expect(builder.createInvoiceFromNormalizedOrder(good).nifHold).toBeUndefined();
  });

  it("keeps reporting an address-line NIF that fails the checksum", () => {
    const badNif = orderWith({
      country_code: "PT", country: "Portugal", address1: "Rua A", city: "Lisboa", address2: "258078203",
    });
    const { nifHold } = new IxBuilder(shopConfig()).createInvoiceFromNormalizedOrder(badNif);
    expect(nifHold).toEqual({ kind: "address_tax_id", raw: "258078203", field: "billing.address2" });
    expect(nifHoldReason(nifHold!)).toBe('nif_invalid: "258078203" em billing.address2');
  });
});
