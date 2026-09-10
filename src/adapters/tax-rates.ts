/**
 * Which regime a sale was made under, and what VAT follows from it.
 *
 * ONE decision, in ONE place, before any destination sees the order. It used to
 * be five, and they interacted in ways nobody could hold in their head: the rate
 * was decided here from the shipping country, the exemption code was decided
 * later inside the InvoiceXpress adapter from the BILLING country, reverse
 * charge lived in the legacy Shopify builder and reached no other destination at
 * all, and the export article was named by a third module. That is how Wim Hof
 * Method stamped M40 — the export/autoliquidação article — on a French
 * CONSUMER: the naming half and the money half never met.
 *
 * THE REGIME IS A FACT, NOT A PREFERENCE. It follows from the buyer: which
 * country, whether they are a registered business, and whether VIES says so.
 * What the CONNECTION declares is not rules but REGISTRATIONS — "I am
 * registered for OSS", "I supply services under art. 6.º n.º 6 / art. 196.º",
 * "I invoice into the islands". A merchant authoring "country = FR then 20 %"
 * would be encoding tax law, and owning the error when it is wrong.
 *
 * Each registration authorises exactly one rung's effect on MONEY, and
 * `ix_derive_exemption` authorises only the NAMING. That split is what makes
 * "nothing changes for a merchant who changed no config" true rung by rung
 * rather than as a hope — and it is pinned by a test that diffs the whole order.
 *
 * Rates are normally transported, not computed: Shopify works one out, Stripe
 * Tax works one out, and every destination reads `item.tax`. This module only
 * has to decide when the source charged nothing — measured on WHM, 10/09/2026:
 * `automatic_tax` disabled, no tax on the PaymentIntent, none on the charge, and
 * the Stripe invoice named in the metadata `void` and untaxed. When it does
 * decide, it rewrites the line so no money moves: the customer paid what they
 * paid, and the reconciliation guard still has to agree.
 *
 * OFF unless a registration is declared. All of them live in
 * `connections.destination_config_json`, which the legacy `integrations` row
 * does not have — so the whole Shopify fleet, where `oss_enabled` has defaulted
 * to 1 since migration 0002 without ever selecting a rate, is excluded by
 * construction. No migration, no new column, no flag day.
 *
 * ponytail: the legacy Shopify→InvoiceXpress path does NOT come through here.
 * It keeps its own reverse charge, its own `pending_reverse_charge` deferral and
 * its own precondition list. Two mechanisms, deliberately: that path is the only
 * one that already HAS reverse charge, and routing the fleet through this ladder
 * would re-rate it on a setting nobody chose. Upgrade path is the day
 * `DESTINATION_VIA_ADAPTER=1` becomes the default, and the migration belongs to
 * that flip.
 *
 * ponytail: the legal mention reaches InvoiceXpress only. Moloni and Vendus
 * render their own text from the SAF-T code, so only the code is stamped for
 * them. Upgrade path is Moloni's header note, worth writing the day an
 * accountant asks for the article on a Moloni document.
 *
 * ponytail: being a business is proved by a VIES-confirmed VAT number and
 * nothing else. The legacy path also demands a non-empty billing company, which
 * is deliberately not carried over: it rejects a real GmbH that supplied a VAT
 * number through a Stripe checkout with no company field. Upgrade path is a real
 * `is_business` signal on Normalized, if a source ever provides one.
 */
import type { Normalized } from "../api/normalize-shopify";
import type { AdapterCtx, DestinationKind } from "./types";
import { EU_COUNTRIES, SELLER_COUNTRY } from "../ix/eu-countries";
import { deriveProductReference } from "./destinations/moloni-destination";
import { classifyExemption, type FiscalClassification } from "../ix/fiscal-classification";
import { IxBuilder } from "../ix/builder";

/**
 * Standard VAT rates, EU-27, verified against the European Commission's
 * "VAT rates applied in the Member States of the European Union" on the date
 * recorded below.
 *
 * ponytail: STANDARD rates only. A reduced-rate product — a book, a hotel
 * night, food — sold cross-border is re-rated to the destination's STANDARD
 * rate, which is wrong for that product. The escape hatch already exists and
 * already outranks this: a per-SKU `product_overrides.tax_rate`, or the
 * RIOKO-ISBN-BOOK rule for a bookseller's whole catalogue. Both are skipped
 * below. Upgrade path is a second table keyed by (country, category), worth
 * writing when a merchant actually sells reduced-rate goods cross-border.
 *
 * ponytail: a static table with a date on it, not a feed. These move about
 * twice a year across 27 states. Upgrade path is a monthly job that diffs this
 * against the Commission's table and opens an incident — never a live fetch on
 * the invoicing path, where a slow answer costs a document.
 */
export const EU_VAT_RATES_VERIFIED = "2026-09-10";

export const EU_STANDARD_VAT_RATES: Readonly<Record<string, number>> = {
  AT: 20, BE: 21, BG: 20, CY: 19, CZ: 21, DE: 19, DK: 25, EE: 24,
  ES: 21, FI: 25.5, FR: 20, GR: 24, HR: 25, HU: 27, IE: 23, IT: 22,
  LT: 21, LU: 17, LV: 21, MT: 18, NL: 21, PL: 23, PT: 23, RO: 21,
  SE: 25, SI: 22, SK: 23,
};

/**
 * Vendus maps a rate to one of four Portuguese tax codes and then computes the
 * VAT itself from that code. Anything else becomes "OUT", and the document goes
 * out with the right total and a wrong VAT breakdown, silently. It is the only
 * silently-wrong path this change could open, so it is refused instead.
 */
const VENDUS_EXPRESSIBLE_RATES = new Set([0, 6, 13, 23]);

/**
 * Which regime the sale was made under. One per sale, decided from facts about
 * the buyer, never from a merchant's preference.
 */
export type VatRegime =
  | "off"                        // no registration: nothing was decided
  | "domestic"                   // seller's own country
  | "pt_regional"                // Madeira / Azores, by the customer's domicile
  | "oss"                        // intra-EU distance selling to a consumer
  | "reverse_charge"             // intra-EU supply to a VIES-confirmed business
  | "reverse_charge_unverified"  // the buyer claims one and VIES did not answer
  | "export";                    // outside the EU

export interface VatDecision {
  /** Whether any registration was declared, i.e. whether anything was decided. */
  enabled: boolean;
  /** What the sale turned out to be. */
  regime: VatRegime;
  /** The country the decision was made from. Empty when unknown. */
  country: string;
  /** How many lines had their rate changed. */
  changed: number;
  /** The exemption code stamped on the document, if any. */
  exemptionCode: string | null;
  /**
   * The full classification, for InvoiceXpress, which also wants the legal
   * mention and the basis. Moloni and Vendus need neither: they render the text
   * from the SAF-T code themselves.
   */
  fiscal: FiscalClassification | null;
  /**
   * The buyer gave an EU VAT number and VIES did not answer. The money is right
   * either way, but a certified document would declare a regime nobody
   * verified, so it is held as a draft.
   */
  hold: string | null;
  /**
   * Set when a rate SHOULD have changed and could not. The pipeline turns this
   * into a draft and one notice, rather than a wrong document or a sale that
   * never gets billed at all. Never set when nothing needed changing.
   */
  holdReason: string | null;
}

const OFF: VatDecision = {
  enabled: false, regime: "off", country: "", changed: 0,
  exemptionCode: null, fiscal: null, hold: null, holdReason: null,
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const ceil2 = (n: number) => Math.ceil(n * 100) / 100;

/**
 * The country whose VAT applies, by the place-of-supply rule for distance
 * selling: where the goods or services go.
 *
 * Deliberately the OPPOSITE priority to the invoice's CLIENT block, which is
 * billing-first. The two answer different questions — who to bill, and whose
 * VAT to charge — and merging them would quietly get one of them wrong.
 */
export function ossCountry(order: Normalized["order"]): string {
  const candidates = [
    order.shipping_address?.country_code,
    order.billing_address?.country_code,
    (order.customer as any)?.default_address?.country_code,
  ];
  for (const c of candidates) {
    const cc = String(c ?? "").trim().toUpperCase();
    if (cc.length === 2) return cc;
  }
  return "";
}

/** The exemption code a zero-rated non-EU sale carries. */
export function ossExemptionCode(ctx: AdapterCtx): string {
  const stated = String((ctx.destinationConfig as any)?.oss_export_exemption_code ?? "").trim();
  return stated || "M40";
}

/**
 * The rate the buyer's country imposes, or null to leave the source's alone.
 *
 * `sourceCharged` is the rate the payment actually collected, and it matters in
 * exactly one place: at home. A Portuguese sale already taxed at 6 % is a book
 * or a hotel night, and overwriting it with the standard 23 % would break a
 * correct invoice. So a domestic rate is filled in only when it is missing.
 */
export function ossRateFor(country: string, sourceCharged: number): number | null {
  if (!country) return null;
  if (!EU_COUNTRIES.has(country)) return 0;
  if (country === SELLER_COUNTRY) {
    return sourceCharged > 0 ? null : (EU_STANDARD_VAT_RATES[SELLER_COUNTRY] ?? null);
  }
  return EU_STANDARD_VAT_RATES[country] ?? null;
}

/**
 * Portugal's autonomous regions, by the customer's postal code.
 *
 * 9000-9499 is Madeira (9400-9499 being Porto Santo, part of the same region)
 * and 9500-9999 the Azores. Mainland codes are 1000-8999, so a four-digit
 * prefix is the whole test.
 *
 * ponytail: STANDARD regional rates only, and only as a replacement for the
 * mainland standard. Madeira and the Azores have their own reduced rates too
 * (5 % / 12 % and 4 % / 9 %); a line the source already taxed at a reduced
 * rate is left exactly as it is rather than guessed at. Upgrade path is a
 * (region, band) table, worth writing when a merchant actually sells
 * reduced-rate goods into the islands.
 *
 * ponytail: the 9500 boundary is the calibration knob. It matches the postal
 * ranges as published, but it is the one number here that a Portuguese
 * accountant should confirm before this is turned on for a real merchant.
 */
export const PT_REGIONAL_VAT_RATES = { madeira: 22, azores: 16 } as const;

export function ptRegionalRate(postalCode: string | null | undefined): number | null {
  const digits = String(postalCode ?? "").replace(/\D/g, "");
  if (digits.length < 4) return null;
  const prefix = Number(digits.slice(0, 4));
  if (prefix >= 9000 && prefix <= 9499) return PT_REGIONAL_VAT_RATES.madeira;
  if (prefix >= 9500 && prefix <= 9999) return PT_REGIONAL_VAT_RATES.azores;
  return null;
}

/**
 * Where the customer is domiciled, for the regional rate.
 *
 * Billing first here, and shipping first for OSS. That is not an inconsistency:
 * a distance sale of goods is taxed where the goods GO, and a supply of
 * services under the regional rule is taxed where the customer IS.
 */
export function ptDomicilePostalCode(order: Normalized["order"]): string {
  const candidates = [
    order.billing_address?.zip,
    order.shipping_address?.zip,
    (order.customer as any)?.default_address?.zip,
  ];
  for (const z of candidates) {
    const zip = String(z ?? "").trim();
    if (zip) return zip;
  }
  return "";
}

/** An ISBN-13 SKU, for the bookseller rule that outranks this engine. */
const isIsbn13 = (sku: string) => /^(978|979)\d{10}$/.test(sku.replace(/[\s-]/g, ""));

/** A line whose rate the merchant has already decided, by hand. */
function isExplicitlyPriced(ctx: AdapterCtx, item: Normalized["order"]["items"][number]): boolean {
  const key = deriveProductReference(item);
  if (ctx.productOverrides?.get(key)?.tax_rate != null) return true;
  // The bookseller rule: one synthetic override covers every ISBN in the
  // catalogue, so there is no per-title entry to find.
  if (ctx.productOverrides?.get("RIOKO-ISBN-BOOK")?.tax_rate != null && isIsbn13(String(item.sku ?? ""))) return true;
  // A Moloni product the merchant mapped carries its own tax rule, which the
  // destination applies without consulting the line. Rewriting the net
  // underneath it would leave the document totalling something other than what
  // was paid, and the money guard would refuse the sale outright.
  const mapped = ctx.productMappings?.get(key);
  return mapped != null && Number.isFinite(mapped) && Number(mapped) > 0;
}

/**
 * Rewrite `normalized.order.items` in place so each line carries the rate the
 * buyer's country imposes, without moving a cent.
 *
 * With r0 the rate charged and r1 the rate owed, scaling the net by
 * k = (100 + r0) / (100 + r1) leaves the line's gross identical:
 *
 *     gross' = k · net · (1 + r1/100) = net · (1 + r0/100) = gross
 *
 * exactly, before any rounding.
 *
 * Rounding is the hard half. InvoiceXpress stores `unit_price` at two decimals
 * and, on POST, silently ignores `items[*].discount_amount` — the only per-line
 * discount it honours is the percentage. Wim Hof Method's French sale is the
 * worked example: 181,35 € at 20 % is a net of 151,125, and no two-decimal net
 * reaches it (151,13 × 1,2 = 181,36; 151,12 × 1,2 = 181,34). So the line is
 * expressed the way `IxBuilder.buildLine` already expresses one — the net
 * CEILED to 2dp, plus the discount percentage that brings the subtotal back
 * down to the exact target — rather than with a 4dp net that IX would round and
 * a `discount_amount` it would drop. Moloni and Vendus read the same
 * percentage.
 *
 * A monetary allocation is folded into that percentage rather than scaled: it
 * is already inside the line's gross, which is the quantity being preserved.
 */
/**
 * Which regime this sale was made under, from facts about the buyer alone.
 *
 * Export first: a business outside the EU is an export, not a reverse charge,
 * and getting that order wrong is the mirror of the failure this whole module
 * exists for — an EU consumer stamped with the export article.
 */
function resolveRegime(
  country: string,
  fiscal: FiscalClassification | null,
  regionalRate: number | null,
): VatRegime {
  if (!country) return "off";
  if (!EU_COUNTRIES.has(country)) return "export";
  if (fiscal?.basis === "intra_eu_b2b") return "reverse_charge";
  if (fiscal?.basis === "intra_eu_b2b_unverified") return "reverse_charge_unverified";
  if (country === SELLER_COUNTRY) return regionalRate != null ? "pt_regional" : "domestic";
  return "oss";
}

export async function decideVat(
  normalized: Normalized,
  ctx: AdapterCtx,
  destination: DestinationKind,
): Promise<VatDecision> {
  const on = (key: string) => {
    const v = (ctx.destinationConfig as any)?.[key];
    return v === true || Number(v) === 1;
  };
  const ossOn = on("oss_engine");
  const regionalOn = on("pt_regional_rates");
  const rcOn = on("b2b_reverse_charge_pipeline");
  // Reads `config`, not the blob: it is one of CONNECTION_FISCAL_FLAGS, which
  // projectConnectionBehaviour already copies off the connection.
  const deriveOn = Number((ctx.config as any)?.ix_derive_exemption) === 1;
  if (!ossOn && !regionalOn && !rcOn && !deriveOn) return OFF;

  const country = ossCountry(normalized.order);

  // ONE classification, from ONE country, so the code and the rate can never
  // disagree. Until now the rate was decided here from the shipping country and
  // the code was decided later, inside the InvoiceXpress adapter, from the
  // billing country — two answers to one question, and only one of them ever
  // reached Moloni or Vendus.
  let fiscal: FiscalClassification | null = null;
  if (country && (rcOn || deriveOn)) {
    fiscal = await classifyExemption({
      buyerCountryCode: country,
      // ponytail: reuses IxBuilder's extractor rather than moving it out. It is
      // the only implementation, it is well covered, and lifting it is a bigger
      // diff than the whole of this change. Upgrade path: give it its own module
      // the day a second caller wants it without constructing a builder.
      euVatCandidates: new IxBuilder(ctx.config).extractEuVatCandidates(normalized),
      config: ctx.config,
      viesChecker: ctx.viesChecker,
    });
  }

  const regionalRate = regionalOn && country === SELLER_COUNTRY
    ? ptRegionalRate(ptDomicilePostalCode(normalized.order))
    : null;
  const regime = resolveRegime(country, fiscal, regionalRate);
  const mainland = EU_STANDARD_VAT_RATES[SELLER_COUNTRY];

  /**
   * The rate this regime imposes, or null to leave the source's alone.
   *
   * Every branch is gated on its OWN registration, which is what makes "nothing
   * changes for a merchant who changed no config" true rung by rung rather than
   * as a hope: naming a regime (`ix_derive_exemption`) never moves money on its
   * own, and each money rung needs the merchant to have declared it.
   */
  const rateFor = (r0: number): number | null => {
    switch (regime) {
      case "export":
        return ossOn ? 0 : null;
      case "reverse_charge":
        return rcOn ? 0 : null;
      // Deliberately never re-rated. The two candidate answers here are 0% and
      // the destination's full rate, and choosing wrong declares a regime nobody
      // verified. The document keeps what was charged and is held as a draft.
      case "reverse_charge_unverified":
        return null;
      case "pt_regional":
        return regionalRate != null && (r0 === 0 || r0 === mainland) ? regionalRate : null;
      case "oss":
        return ossOn ? (EU_STANDARD_VAT_RATES[country] ?? null) : null;
      case "domestic":
        return ossOn ? ossRateFor(country, r0) : null;
      default:
        return null;
    }
  };

  const items = normalized.order.items ?? [];
  // Prices already contain the tax. Only then can a rate change be absorbed
  // without altering what the customer paid.
  const gross = Number((ctx.config as any)?.vat_included) === 1;

  let changed = 0;
  let hasZeroRatedLine = false;
  const blocked: string[] = [];

  for (const item of items) {
    const r0 = Number(item.tax?.unit_amount) === 0 ? 0 : Number(item.tax?.value ?? 0);

    // A line the merchant priced by hand keeps its rate — but it still counts
    // towards whether the DOCUMENT is exempt, because InvoiceXpress asks for an
    // exemption code the moment any single line sits at 0%.
    if (isExplicitlyPriced(ctx, item)) {
      if (r0 === 0) hasZeroRatedLine = true;
      continue;
    }

    // A regional rate stands in for the mainland standard and for nothing else.
    // A line already taxed at 6 % or 13 % is on a reduced band, which has its
    // own regional values this does not carry — so it is left exactly as it is.
    const r1 = rateFor(r0);
    if (r1 == null) {
      if (r0 === 0) hasZeroRatedLine = true;
      continue;
    }
    if (r1 === 0) hasZeroRatedLine = true;

    if (r1 === r0) continue;

    if (!gross) {
      blocked.push(`a linha "${item.title}" foi cobrada a ${r0}% e o país do comprador impõe ${r1}%`);
      continue;
    }
    if (destination === "vendus" && !VENDUS_EXPRESSIBLE_RATES.has(r1)) {
      blocked.push(`o Vendus não sabe exprimir ${r1}% (${country}) e calcularia o IVA a partir de um código errado`);
      continue;
    }

    const qty = Number(item.quantity) || 0;
    if (qty <= 0) continue;

    // The line's gross is the invariant: it is what the customer paid.
    const net0 = (Number(item.unit_price) * qty - (Number(item.discount_allocation_amount) || 0))
      * (1 - (Number(item.discount?.percent) || 0) / 100);
    const lineGross = net0 * (1 + r0 / 100);
    const targetNet = lineGross / (1 + r1 / 100);
    if (!(targetNet > 0)) continue;

    // Ceil, so what is left over is a POSITIVE discount — IX rejects a negative
    // one — and then solve for the percentage that lands on the target exactly.
    const unit = ceil2(targetNet / qty);
    const percent = round4(Math.max(0, (1 - targetNet / (unit * qty)) * 100));

    item.unit_price = unit;
    item.unit_price_calculated = unit;
    item.discount = { name: item.discount?.name ?? "", percent };
    item.discount_allocation_amount = 0;
    item.tax = {
      name: item.tax?.name || "VAT",
      value: r1,
      // Zero EXACTLY when the rate is zero: three destinations read this field
      // as "was any tax collected", not as an amount.
      unit_amount: r1 === 0 ? 0 : round2(targetNet * r1 / 100),
    };
    changed++;
  }

  // A code is only ever stamped on a document that HAS an exempt line. Asking
  // for one on a fully taxed document is how a shop ends up declaring an
  // exemption it never had — the same rule IxBuilder applies at
  // shouldRequestTaxExemptionReason.
  //
  // Precedence: what the merchant explicitly stated for exports, then the
  // article the classification named, then the connection's own default.
  const statedExportCode = String((ctx.destinationConfig as any)?.oss_export_exemption_code ?? "").trim();
  const classifiedCode = (fiscal?.exemptionCode ?? "").trim() || null;
  const exemptionCode = !hasZeroRatedLine
    ? null
    : (regime === "export" && statedExportCode)
      ? statedExportCode
      : (classifiedCode ?? (regime === "export" ? ossExemptionCode(ctx) : null));

  if (exemptionCode) {
    // Stamped onto the two per-run config objects the three destinations already
    // read, rather than threaded through three adapter signatures. This is also
    // how a reverse-charge code reaches Moloni and Vendus, which is what makes
    // the regime reach them at all.
    //
    // Written only when there IS a code: `config.ix_exemption_reason` is the
    // merchant's own setting and the fallback for a domestic exempt line, so
    // clearing it here would destroy a configured value to prevent a leak that
    // needs a reused ctx — and buildAdapterCtx builds one per pipeline run.
    //
    // ponytail: give createDraft an explicit exemptionCode argument if a fourth
    // destination ever needs it.
    (ctx.config as any).ix_exemption_reason = exemptionCode;
    if (ctx.destinationConfig) (ctx.destinationConfig as any).exemption_reason = exemptionCode;
  }

  return {
    enabled: true,
    regime,
    country,
    changed,
    exemptionCode,
    fiscal,
    hold: fiscal?.hold ?? null,
    holdReason: blocked.length
      ? `a taxa do país do comprador não pôde ser aplicada: ${blocked.join("; ")}`
      : null,
  };
}
