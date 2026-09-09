/**
 * The five countries InvoiceXpress spells its own way.
 *
 * IX validates a client's country against its own list of English names. A name
 * it does not recognise is not refused — the document is created and the country
 * is simply DROPPED, silently. Measured on a live account (2026-09-09): a UK
 * buyer's invoice-receipt, doc 269811236, came out with a client carrying no
 * country at all, while the same account's older clients — written by the
 * merchant's previous system — all said "UK".
 *
 * Confirmed by creating a client per country in the sandbox and reading it back:
 * 58 of 63 Intl names are stored as sent; these five are dropped, and these are
 * the spellings IX accepts.
 *
 * Both directions matter. Stripe gives an ISO code, so the map is consulted on
 * the way out of Intl. Shopify gives a name already ("United Kingdom"), which
 * used to sail through untouched — so every Shopify shop selling to the UK was
 * filing clients with no country, the same way, for as long as this existed.
 */

import { describe, it, expect } from "vitest";
import { IxBuilder } from "./builder";

const cfg: any = { ix_document_type: "invoice_receipt" };

/** The country as it reaches IX, for an order carrying `value`. */
const countryFor = (value: string): string | undefined =>
  new IxBuilder(cfg).buildInvoiceClient({
    order: {
      customer: { email: "buyer@example.com" },
      billing_address: { name: "A Buyer", country: value, country_code: value.length === 2 ? value : "" },
      shipping_address: {},
      note: null,
      note_attributes: [],
    },
  } as any).country;

describe("country names InvoiceXpress accepts", () => {
  it("calls the United Kingdom UK, from the ISO code", () => {
    expect(countryFor("GB")).toBe("UK");
  });

  it("calls the United Kingdom UK, from the name Shopify sends", () => {
    expect(countryFor("United Kingdom")).toBe("UK");
  });

  it("keeps the four other spellings IX insists on", () => {
    expect(countryFor("CZ")).toBe("Czech Republic");
    expect(countryFor("KR")).toBe("Korea, South");
    expect(countryFor("HK")).toBe("Hong Kong");
    expect(countryFor("TR")).toBe("Turkey");
  });

  it("normalises those same names when a source spells them differently", () => {
    expect(countryFor("Czechia")).toBe("Czech Republic");
    expect(countryFor("South Korea")).toBe("Korea, South");
    expect(countryFor("Türkiye")).toBe("Turkey");
  });

  it("leaves alone the ones IX already agrees with", () => {
    // 58 of 63 need no help; overriding them would be inventing a problem.
    expect(countryFor("AU")).toBe("Australia");
    expect(countryFor("US")).toBe("United States");
    expect(countryFor("Germany")).toBe("Germany");
  });
});
