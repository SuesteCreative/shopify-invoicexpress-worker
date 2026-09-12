/**
 * Does the exemption code on a document contradict the buyer it was issued to?
 *
 * Measured on Wim Hof Method, 09/09/2026: eight documents, every one at 0 % VAT
 * stamped M40 — "autoliquidação, serviços a sujeito passivo de outro
 * Estado-membro" — issued to private consumers with no VAT number anywhere (zero
 * `tax_ids` across 403 Stripe payments that year). Nothing chose that code per
 * sale: the rate engine had no registration so it decided nothing, and
 * `shouldRequestTaxExemptionReason` stamped the connection's global code because
 * InvoiceXpress demands one for any zero-rated line. The exemption was what was
 * left when nothing decided, and no counter, log or incident said a word.
 *
 * MOST OF THESE TESTS ASSERT SILENCE, and that is the point. Eleven of the
 * thirteen live connections carry a seller-side exemption (art. 9.º, art. 53.º)
 * and are perfectly correct; a check that warned about them would be the phantom
 * generator this fleet has been burned by more than any other failure. Precision
 * IS the feature, so the cases that must stay quiet outnumber the ones that fire.
 */

import { describe, it, expect } from "vitest";
import { checkRegimeClaim } from "./document-verify";

describe("checkRegimeClaim — what must fire", () => {
  it("catches a B2B reverse-charge code on a buyer with no tax id (the WHM case)", () => {
    const out = checkRegimeClaim({
      exemption_code: "M40",
      buyer_country: "France",
      buyer_tax_id: "",
    });
    expect(out).toHaveLength(1);
    expect(out[0].field).toBe("exemption_code");
    expect(out[0].meaning).toContain("sujeito passivo");
  });

  it("catches M16 the same way — it makes the same claim about the buyer", () => {
    expect(checkRegimeClaim({ exemption_code: "M16", buyer_country: "Germany", buyer_tax_id: "" }))
      .toHaveLength(1);
  });

  it("names the country in the finding, so a reader need not open the document", () => {
    const out = checkRegimeClaim({ exemption_code: "M40", buyer_country: "France", buyer_tax_id: "" });
    expect(out[0].meaning).toContain("France");
    expect(out[0].stored).toContain("France");
  });

  it("reads the country by NAME, which is how InvoiceXpress stores it", () => {
    // EU_COUNTRIES holds ISO2 and IX holds "France". Comparing them directly is
    // always false, which would have left the EU condition dead on arrival:
    // silent, passing, and finding nothing for ever.
    expect(checkRegimeClaim({ exemption_code: "M40", buyer_country: "FR", buyer_tax_id: "" }))
      .toHaveLength(1);
  });

  it("accepts both spellings of Czechia, because IX uses its own", () => {
    // Intl renders CZ as "Czechia"; IX stores "Czech Republic"
    // (IX_COUNTRY_NAME_OVERRIDE in ix/builder.ts). Missing either one would read
    // a Czech buyer as outside the EU.
    for (const name of ["Czech Republic", "Czechia"]) {
      expect(checkRegimeClaim({ exemption_code: "M40", buyer_country: name, buyer_tax_id: "" }))
        .toHaveLength(1);
    }
  });
});

describe("checkRegimeClaim — what must stay silent", () => {
  it("says nothing about a seller-side exemption, whoever the buyer is", () => {
    // ALLIANCE JIU JITSU (art. 9.º) and lliberta (art. 53.º) charge no VAT at
    // all. Their code is true regardless of the buyer, so every sale they make
    // would be a false positive.
    for (const code of ["M01", "M07", "M10", "M11", "M12", "M13", "M99"]) {
      expect(checkRegimeClaim({ exemption_code: code, buyer_country: "France", buyer_tax_id: "" }))
        .toEqual([]);
    }
  });

  it("says nothing about a fully-taxed document (the MeetFrank case)", () => {
    // 12 sampled MeetFrank documents: all 23 %, no zero-rated line, so no
    // exemption code was ever stamped. No claim, nothing to contradict.
    expect(checkRegimeClaim({ exemption_code: null, buyer_country: "Portugal", buyer_tax_id: "PT513127224" }))
      .toEqual([]);
    expect(checkRegimeClaim({ exemption_code: "", buyer_country: "Portugal", buyer_tax_id: "" }))
      .toEqual([]);
  });

  it("says nothing when the buyer DOES have a tax id", () => {
    expect(checkRegimeClaim({ exemption_code: "M40", buyer_country: "France", buyer_tax_id: "FR12345678901" }))
      .toEqual([]);
  });

  it("treats an unknown fact as unknown, never as an absence", () => {
    // `null` = the destination did not hand us the field (Moloni, Vendus).
    // Reading that as "no tax id" would fabricate a finding out of a field the
    // adapter simply does not populate.
    expect(checkRegimeClaim({ exemption_code: "M40", buyer_tax_id: null })).toEqual([]);
    expect(checkRegimeClaim({ exemption_code: "M40" })).toEqual([]);
  });

  it("asserts NOTHING about M40 on a non-EU buyer, even with no tax id at all", () => {
    // THE CASE A LIVE DRY RUN CAUGHT AND THESE TESTS ORIGINALLY MISSED.
    //
    // Without the EU condition the check fired on all eight WHM documents, of
    // which seven are exactly this shape — non-EU buyer, no tax id — and are
    // sales the merchant has deliberately decided to invoice under M40. One
    // true finding arriving with seven arguments is how a useful signal gets
    // switched off.
    //
    // The pairing is genuinely contested in this repo: `ossExemptionCode`
    // (adapters/tax-rates.ts) stamps M40 on a zero-rated non-EU sale by
    // default; audit-tax-params.mjs reports the same pairing as a finding.
    // M05 is art. 14.º CIVA (export of GOODS), M40 is art. 6.º n.º 6 al. a)
    // (SERVICES to a taxable person outside PT, EU or not). Both can be right
    // depending on what is sold — an accountant's call, not a sweep's.
    for (const country of ["United States", "Switzerland", "Guatemala", "Cambodia",
                           "Azerbaijan", "United Arab Emirates", "UK"]) {
      expect(checkRegimeClaim({ exemption_code: "M40", buyer_country: country, buyer_tax_id: "" }))
        .toEqual([]);
      expect(checkRegimeClaim({ exemption_code: "M40", buyer_country: country, buyer_tax_id: "x" }))
        .toEqual([]);
    }
  });

  it("says nothing when the buyer's country is unknown or unplaceable", () => {
    // An EU claim needs positive evidence that the buyer is in the EU. A country
    // we cannot place is an unknown, and an unknown is never a verdict.
    expect(checkRegimeClaim({ exemption_code: "M40", buyer_country: "", buyer_tax_id: "" })).toEqual([]);
    expect(checkRegimeClaim({ exemption_code: "M40", buyer_country: null, buyer_tax_id: "" })).toEqual([]);
    expect(checkRegimeClaim({ exemption_code: "M40", buyer_country: "Ruritania", buyer_tax_id: "" })).toEqual([]);
  });

  it("is case- and whitespace-insensitive, so formatting never decides a regime", () => {
    expect(checkRegimeClaim({ exemption_code: " m40 ", buyer_country: "France", buyer_tax_id: "" }))
      .toHaveLength(1);
    expect(checkRegimeClaim({ exemption_code: "M40", buyer_country: "  france  ", buyer_tax_id: "" }))
      .toHaveLength(1);
  });
});
