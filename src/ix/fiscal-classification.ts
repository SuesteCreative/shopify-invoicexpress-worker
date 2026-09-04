/**
 * Which legal regime a 0%-VAT document is issued under, decided per sale
 * instead of per shop.
 *
 * A shop has ONE `ix_exemption_reason`, and that is enough while every exempt
 * sale it makes is exempt for the same reason. A merchant selling worldwide
 * breaks that assumption on day one: the same catalogue is an export to a buyer
 * in Australia (art. 14.º CIVA, M05), an intra-Community supply to a
 * VAT-registered company in Germany (art. 14.º RITI, M16), and plain domestic
 * VAT to a buyer in Porto. Stamping one code on all three is not a rounding
 * error — it declares a tax regime the sale was not made under.
 *
 * Stripe Tax already decides the MONEY: it zero-rates the German B2B sale
 * because the buyer supplied a VAT number, and charges Portuguese VAT in Porto.
 * What it cannot do is name the Portuguese legal article on the document. So
 * this module classifies, and never rewrites amounts — if the buyer paid VAT,
 * the invoice says they paid VAT. That is the difference between this and the
 * Shopify reverse-charge path (`IxBuilder.buildReverseChargeInvoice`), which
 * rebuilds the lines at zero because Shopify collected nothing.
 *
 * Gated per connection by `ix_derive_exemption`; with the flag off, callers use
 * the shop-wide code exactly as before.
 */

import { EU_COUNTRIES, SELLER_COUNTRY, isCrossBorderEU } from "./eu-countries";
import { buildAnyExemptionMention } from "./exemption-mentions";
import type { ViesChecker } from "./vies";

/** Art. 14.º CIVA — goods leaving the EU. Not configurable: it is the article. */
export const EXPORT_EXEMPTION_CODE = "M05";

/** The shop's B2B code, when it has not named one. Matches IxBuilder. */
export const DEFAULT_B2B_EXEMPTION_CODE = "M16";

export interface FiscalClassification {
  /** SAF-T exemption code for the document, or null to leave the shop's own. */
  exemptionCode: string | null;
  /** Bilingual legal mention for that code, or "" when there is none to state. */
  mention: string;
  /** True when the document is an intra-Community B2B supply. */
  reverseCharge: boolean;
  /**
   * Set when the classification could not be confirmed and the document must
   * NOT be certified: the buyer gave an EU VAT number and VIES did not answer.
   * The caller holds it as a draft — the money is right either way, but a final
   * document would be declaring a regime nobody verified.
   */
  hold: string | null;
  /** For the document log, so a drift check has something to compare against. */
  basis: "domestic" | "export" | "intra_eu_b2b" | "intra_eu_b2b_unverified" | "configured";
}

export interface ClassifyInput {
  /** ISO-2 of the buyer's billing country. Empty/unknown is handled. */
  buyerCountryCode: string | null | undefined;
  /** EU VAT candidates already extracted from the order (IxBuilder does this). */
  euVatCandidates: Array<{ countryCode: string; vatNumber: string }>;
  config: {
    ix_exemption_reason?: string | null;
    ix_b2b_exemption_reason?: string | null;
  };
  /** Absent = no VIES available; an EU VAT then classifies as unverified. */
  viesChecker?: ViesChecker;
}

/**
 * The shop-wide code, as a classification. What every caller got before this
 * module existed, and still the answer for a domestic exempt sale.
 */
function configured(config: ClassifyInput["config"]): FiscalClassification {
  const code = (config.ix_exemption_reason ?? "").trim() || null;
  return {
    exemptionCode: code,
    mention: buildAnyExemptionMention(code),
    reverseCharge: false,
    hold: null,
    basis: code ? "configured" : "domestic",
  };
}

/**
 * Classify one sale. Only ever consulted for a document that HAS a 0%-VAT line
 * — a fully taxed sale needs no exemption code, and asking for one on a taxed
 * document is how a shop ends up declaring an exemption it never had.
 *
 * VIES is called at most once per candidate, and only for a cross-border EU
 * buyer who supplied something VAT-shaped. It is KV-cached upstream.
 */
export async function classifyExemption(input: ClassifyInput): Promise<FiscalClassification> {
  const cc = String(input.buyerCountryCode ?? "").trim().toUpperCase();

  // No country on the sale: we cannot tell an export from a domestic sale, and
  // guessing would be worse than the status quo. Keep the shop's code.
  if (!cc) return configured(input.config);

  // Outside the EU: an export, exempt under art. 14.º CIVA. True regardless of
  // whether the buyer is a company — what matters is that the goods leave.
  if (!EU_COUNTRIES.has(cc)) {
    return {
      exemptionCode: EXPORT_EXEMPTION_CODE,
      mention: buildAnyExemptionMention(EXPORT_EXEMPTION_CODE),
      reverseCharge: false,
      hold: null,
      basis: "export",
    };
  }

  // Seller's own country: domestic. A 0% line here is exempt for whatever
  // reason the shop is configured with (art. 53.º, books, tickets…).
  if (!isCrossBorderEU(cc)) return configured(input.config);

  // Cross-border EU. Without a VAT number this is a distance sale to a
  // consumer, which is taxed at the destination rate under OSS — a 0% line
  // means something else is going on, and the shop's own code is the honest
  // answer rather than inventing a B2B exemption.
  const candidates = input.euVatCandidates.filter(c => EU_COUNTRIES.has(c.countryCode) && c.countryCode !== SELLER_COUNTRY);
  if (candidates.length === 0) return configured(input.config);

  const b2bCode = (input.config.ix_b2b_exemption_reason ?? "").trim() || DEFAULT_B2B_EXEMPTION_CODE;

  if (!input.viesChecker) {
    return unverified(candidates[0], b2bCode, "VIES não está disponível nesta ligação");
  }

  let unreachable: { countryCode: string; vatNumber: string } | null = null;
  for (const candidate of candidates) {
    const answer = await input.viesChecker(candidate.countryCode, candidate.vatNumber);
    if (answer === true) {
      const vat = `${candidate.countryCode}${candidate.vatNumber}`;
      return {
        exemptionCode: b2bCode,
        mention: withBuyerVat(buildAnyExemptionMention(b2bCode), vat),
        reverseCharge: true,
        hold: null,
        basis: "intra_eu_b2b",
      };
    }
    // null = VIES unreachable (not "invalid"). Remember it, but keep trying the
    // other candidates: one of them may still come back confirmed.
    if (answer === null) unreachable ??= candidate;
  }

  // Every candidate answered, and none was a real VAT number: the buyer typed
  // something VAT-shaped that is not registered. Not a B2B supply.
  if (!unreachable) return configured(input.config);

  return unverified(unreachable, b2bCode, "o VIES não respondeu");
}

/**
 * An EU VAT number we could not confirm. The document is built as the B2B
 * supply the buyer's own VAT number claims it is — that is what Stripe zeroed
 * the tax on — but it is held as a draft, because a final document is a
 * declaration and this one has not been verified.
 */
function unverified(
  candidate: { countryCode: string; vatNumber: string },
  b2bCode: string,
  why: string,
): FiscalClassification {
  const vat = `${candidate.countryCode}${candidate.vatNumber}`;
  return {
    exemptionCode: b2bCode,
    mention: withBuyerVat(buildAnyExemptionMention(b2bCode), vat),
    reverseCharge: true,
    hold: `NIF intracomunitário ${vat} por confirmar (${why}) — o documento fica em rascunho até se confirmar a isenção`,
    basis: "intra_eu_b2b_unverified",
  };
}

/**
 * The buyer's VAT number belongs on the document: it is what evidences the
 * exemption to an inspector. Appended to the mention rather than replacing it,
 * and skipped when the code has no mention mapped, so nothing is stamped that
 * would read as a legal text without being one.
 */
function withBuyerVat(mention: string, vat: string): string {
  return mention ? `${mention} (${vat})` : "";
}
