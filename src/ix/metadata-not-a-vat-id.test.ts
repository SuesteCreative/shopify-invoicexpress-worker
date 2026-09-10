import { describe, it, expect } from "vitest";
import { IxBuilder } from "./builder";
import { isPlausibleEuVatLength } from "./eu-countries";

// On a Stripe payment the note_attributes ARE the whole metadata bag
// (metadataToNoteAttributes in stripe-source.ts), so anything the store's
// software attaches arrives here looking exactly like a field the buyer typed.
// Measured on Wim Hof Method, 10/09/2026: document 269830299 went out with
// client.fiscal_id = "FR1428932220", which was the buyer's Google Analytics
// client id "1428932220.1788599389" combined with their French billing country.
const cfg: any = {
  user_id: "u1", shopify_domain: null, ix_document_type: "invoice_receipt",
  vat_included: 1, oss_enabled: 1, b2b_reverse_charge: 0, pos_mode: 0, auto_finalize: 0,
};
const b = () => new IxBuilder(cfg);

const order = (note_attributes: Array<{ name: string; value: string }>, cc = "FR"): any => ({
  order: {
    id: 1, order_number: 1, currency: "EUR", total_price: "181.35",
    customer: { first_name: "Samuel", last_name: "Plan", name: "Samuel Plan" },
    billing_address: { country_code: cc, name: "Samuel Plan" },
    note_attributes,
  },
});

const GA = { name: "google_analytics_client", value: "1428932220.1788599389" };

describe("unlabelled Stripe metadata is not a VAT id", () => {
  it("does not turn a Google Analytics client id into a fiscal id", () => {
    expect(b().extractEuVatCandidates(order([GA]))).toEqual([]);
    expect(b().buildInvoiceClient(order([GA])).fiscal_id).toBeUndefined();
  });

  it("ignores every other unlabelled metadata key of tax-id shape", () => {
    const noise = [
      { name: "session_id", value: "1078861486" },
      { name: "order_ref", value: "2019910752" },
      { name: "ab_test_bucket", value: "18275011357" },
    ];
    expect(b().extractEuVatCandidates(order(noise))).toEqual([]);
  });

  it("still reads a value from a field whose NAME claims to be a tax id", () => {
    // France's VAT body is 11 characters, so a real one passes the length gate.
    const c = order([GA, { name: "vat_number", value: "12345678901" }]);
    expect(b().extractEuVatCandidates(c)).toEqual([
      { countryCode: "FR", vatNumber: "12345678901" },
    ]);
  });

  it("rejects a labelled number that is the wrong length for the buyer's country", () => {
    // Ten digits is a plausible PL or RO VAT number and is not a French one.
    expect(b().extractEuVatCandidates(order([{ name: "tva", value: "1428932220" }]))).toEqual([]);
    expect(b().extractEuVatCandidates(order([{ name: "tva", value: "1428932220" }], "PL")))
      .toEqual([{ countryCode: "PL", vatNumber: "1428932220" }]);
  });

  it("leaves a country-prefixed number in free text alone", () => {
    // The prefixed branch is unchanged: an explicit FR + 11 chars still counts.
    const c = order([{ name: "notes", value: "our VAT is FR12345678901" }]);
    expect(b().extractEuVatCandidates(c)).toEqual([
      { countryCode: "FR", vatNumber: "12345678901" },
    ]);
  });
});

describe("EU VAT length gate", () => {
  it("knows each member state's body length", () => {
    expect(isPlausibleEuVatLength("FR", "1428932220")).toBe(false); // 10, FR wants 11
    expect(isPlausibleEuVatLength("FR", "12345678901")).toBe(true);
    expect(isPlausibleEuVatLength("PT", "123456789")).toBe(true);
    expect(isPlausibleEuVatLength("DE", "123456789")).toBe(true);
    expect(isPlausibleEuVatLength("NL", "123456789B01")).toBe(true);
  });

  it("says no for a country that is not in the EU", () => {
    expect(isPlausibleEuVatLength("GB", "123456789")).toBe(false);
    expect(isPlausibleEuVatLength("AU", "1078861486")).toBe(false);
  });
});
