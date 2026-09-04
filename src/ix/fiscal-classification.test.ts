/**
 * Cover for the gap a globally-selling merchant walked into on Stripe→IX: one
 * shop-wide `ix_exemption_reason` stamped on every 0%-VAT document, whatever
 * the reason it was actually zero.
 *
 * Stripe Tax zero-rates a sale to a VAT-registered German company (reverse
 * charge) and a sale shipped to Australia (an export) alike. Both then left as
 * the shop's configured code — for this merchant M05, art. 14.º CIVA — so every
 * intra-Community B2B supply went out declaring itself an export, with no
 * mention of the article that actually exempts it. The money was right on all
 * of them, which is why nothing caught it.
 *
 * These tests pin the classification only. The money is never touched here: a
 * buyer who paid VAT is invoiced for VAT (see fiscal-classification-build.test).
 */

import { describe, it, expect } from "vitest";
import { classifyExemption, EXPORT_EXEMPTION_CODE } from "./fiscal-classification";

const shopConfig = (extra: any = {}): any => ({
  ix_exemption_reason: "M10",
  ix_b2b_exemption_reason: "M16",
  ...extra,
});

/** A VIES stub. `true` confirmed, `false` refused, `null` unreachable. */
const vies = (answer: boolean | null) => async () => answer;

const euVat = (countryCode: string, vatNumber: string) => [{ countryCode, vatNumber }];

describe("classifyExemption", () => {
  it("calls a sale outside the EU an export, whatever the shop's own code is", async () => {
    const c = await classifyExemption({
      buyerCountryCode: "AU",
      euVatCandidates: [],
      config: shopConfig(),
    });

    expect(c.exemptionCode).toBe(EXPORT_EXEMPTION_CODE);
    expect(c.basis).toBe("export");
    expect(c.mention).toMatch(/art\.º 14\.º do CIVA/);
    expect(c.hold).toBeNull();
    expect(c.reverseCharge).toBe(false);
  });

  it("treats a company buyer outside the EU as an export too — what matters is that the goods leave", async () => {
    const c = await classifyExemption({
      buyerCountryCode: "US",
      euVatCandidates: euVat("DE", "811569869"),
      config: shopConfig(),
      viesChecker: vies(true),
    });

    expect(c.exemptionCode).toBe(EXPORT_EXEMPTION_CODE);
    expect(c.reverseCharge).toBe(false);
  });

  it("leaves a domestic sale on the shop's configured reason", async () => {
    const c = await classifyExemption({
      buyerCountryCode: "PT",
      euVatCandidates: euVat("PT", "501442600"),
      config: shopConfig(),
      viesChecker: vies(true),
    });

    expect(c.exemptionCode).toBe("M10");
    expect(c.basis).toBe("configured");
    expect(c.reverseCharge).toBe(false);
  });

  it("names the intra-Community supply when VIES confirms the buyer's VAT number", async () => {
    const c = await classifyExemption({
      buyerCountryCode: "DE",
      euVatCandidates: euVat("DE", "811569869"),
      config: shopConfig(),
      viesChecker: vies(true),
    });

    expect(c.exemptionCode).toBe("M16");
    expect(c.basis).toBe("intra_eu_b2b");
    expect(c.reverseCharge).toBe(true);
    expect(c.hold).toBeNull();
    // The buyer's VAT number is the evidence for the exemption; it belongs on
    // the document, not only in our logs.
    expect(c.mention).toMatch(/DE811569869/);
    expect(c.mention).toMatch(/RITI/);
  });

  it("honours the shop's own B2B code instead of assuming M16", async () => {
    const c = await classifyExemption({
      buyerCountryCode: "FR",
      euVatCandidates: euVat("FR", "40303265045"),
      config: shopConfig({ ix_b2b_exemption_reason: "M40" }),
      viesChecker: vies(true),
    });

    expect(c.exemptionCode).toBe("M40");
    expect(c.mention).toMatch(/autoliquidação/);
    expect(c.mention).toMatch(/Article 196/);
  });

  it("holds the document when VIES does not answer, rather than certifying a guess", async () => {
    const c = await classifyExemption({
      buyerCountryCode: "DE",
      euVatCandidates: euVat("DE", "811569869"),
      config: shopConfig(),
      viesChecker: vies(null),
    });

    expect(c.exemptionCode).toBe("M16");
    expect(c.basis).toBe("intra_eu_b2b_unverified");
    expect(c.hold).toMatch(/DE811569869/);
    expect(c.hold).toMatch(/rascunho/);
  });

  it("holds it the same way when the connection has no VIES checker at all", async () => {
    const c = await classifyExemption({
      buyerCountryCode: "ES",
      euVatCandidates: euVat("ES", "B12345678"),
      config: shopConfig(),
    });

    expect(c.hold).toBeTruthy();
    expect(c.basis).toBe("intra_eu_b2b_unverified");
  });

  it("keeps trying the other candidates before giving up on an unreachable one", async () => {
    const answers: Array<boolean | null> = [null, true];
    let i = 0;
    const c = await classifyExemption({
      buyerCountryCode: "NL",
      euVatCandidates: [
        { countryCode: "NL", vatNumber: "999999999" },
        { countryCode: "NL", vatNumber: "820646660" },
      ],
      config: shopConfig(),
      viesChecker: async () => answers[i++],
    });

    expect(c.basis).toBe("intra_eu_b2b");
    expect(c.hold).toBeNull();
    expect(c.mention).toMatch(/NL820646660/);
  });

  it("does not invent a B2B exemption when VIES says the number is not registered", async () => {
    const c = await classifyExemption({
      buyerCountryCode: "IT",
      euVatCandidates: euVat("IT", "12345678901"),
      config: shopConfig(),
      viesChecker: vies(false),
    });

    expect(c.exemptionCode).toBe("M10");
    expect(c.basis).toBe("configured");
    expect(c.reverseCharge).toBe(false);
  });

  it("does not invent one for an EU consumer either — no VAT number, no B2B", async () => {
    const c = await classifyExemption({
      buyerCountryCode: "BE",
      euVatCandidates: [],
      config: shopConfig(),
      viesChecker: vies(true),
    });

    expect(c.exemptionCode).toBe("M10");
    expect(c.reverseCharge).toBe(false);
  });

  it("keeps the shop's code when the sale carries no country — a guess would be worse", async () => {
    const c = await classifyExemption({
      buyerCountryCode: "",
      euVatCandidates: [],
      config: shopConfig(),
    });

    expect(c.exemptionCode).toBe("M10");
  });

  it("reports no code at all when the shop has none configured", async () => {
    const c = await classifyExemption({
      buyerCountryCode: "PT",
      euVatCandidates: [],
      config: shopConfig({ ix_exemption_reason: "  " }),
    });

    expect(c.exemptionCode).toBeNull();
    expect(c.mention).toBe("");
    expect(c.basis).toBe("domestic");
  });
});
