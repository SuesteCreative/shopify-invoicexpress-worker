/**
 * Which VAT rate a line carries, when the merchant asks us to decide it.
 *
 * Normally the rate is transported, not computed: Shopify works it out, Stripe
 * Tax works it out, and every destination adapter reads `item.tax` and passes
 * it on. That breaks down when the source charges no VAT at all. Wim Hof Method
 * sells courses across the EU through raw PaymentIntents with `automatic_tax`
 * disabled — measured 10/09/2026, there is no tax on the PaymentIntent, none on
 * the charge, and the Stripe invoice named in the metadata is `void` and
 * untaxed. A French consumer paying 181,35 € produced a document at 0 % VAT
 * stamped as an export.
 *
 * So this module decides the rate from the buyer's country instead, and
 * rewrites the line so that no money moves: the customer paid what they paid,
 * and the reconciliation guard still has to agree.
 *
 * It is OFF unless the connection sets `oss_engine`. The legacy `integrations`
 * row has no `destination_config_json`, so the entire Shopify fleet — where
 * `oss_enabled` has defaulted to 1 since migration 0002 without ever selecting
 * a rate — is excluded by construction, with no migration and no new column.
 *
 * WHAT THIS IS NOT: it is not reverse charge. A B2B supply of services to a
 * VAT-registered business in another member state is taxed in the buyer's
 * country under art. 6.º n.º 6 a) CIVA and leaves here at 0 % with an
 * autoliquidação mention. That is `b2b_reverse_charge` + VIES, and it runs
 * after this, in the IX builder. Turning this on for such a merchant would put
 * French VAT on an invoice that must carry none. MeetFrank is exactly that
 * merchant: 731 documents, all correct, none of them OSS.
 */
import type { Normalized } from "../api/normalize-shopify";
import type { AdapterCtx, DestinationKind } from "./types";
import { EU_COUNTRIES, SELLER_COUNTRY } from "../ix/eu-countries";
import { deriveProductReference } from "./destinations/moloni-destination";

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

export interface OssOutcome {
  /** Whether the engine was on for this connection at all. */
  enabled: boolean;
  /** The country the decision was made from. Empty when unknown. */
  country: string;
  /** How many lines had their rate changed. */
  changed: number;
  /** The exemption code stamped, when the sale was zero-rated as an export. */
  exemptionCode: string | null;
  /**
   * Set when a rate SHOULD have changed and could not. The pipeline turns this
   * into a draft and one notice, rather than a wrong document or a sale that
   * never gets billed at all. Never set when nothing needed changing.
   */
  holdReason: string | null;
}

const OFF: OssOutcome = { enabled: false, country: "", changed: 0, exemptionCode: null, holdReason: null };

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

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
 * exactly, before any rounding. That is what keeps `computeExpectedGross`
 * landing on the amount the customer paid, and `reconcileTotalOrThrow` green
 * without being touched. A monetary discount allocation has to be scaled by the
 * same k; a percentage discount must NOT be, being scale-invariant already.
 *
 * ponytail: nets are kept to 4dp. InvoiceXpress stores `unit_price` at 2, so a
 * line with quantity > 1 can drift by up to half a cent per unit there — at
 * which point the pre-flight reconcile and IX's own read-back refuse the
 * document rather than mis-issue it. Every line this has been measured on is
 * quantity 1. Upgrade path is IxBuilder.buildLine's ceil2 + solve-for-discount
 * trick, if a real merchant ever hits it.
 */
export function applyOssRates(
  normalized: Normalized,
  ctx: AdapterCtx,
  destination: DestinationKind,
): OssOutcome {
  const flag = (ctx.destinationConfig as any)?.oss_engine;
  if (flag !== true && Number(flag) !== 1) return OFF;

  const country = ossCountry(normalized.order);
  const items = normalized.order.items ?? [];
  // Prices already contain the tax. Only then can a rate change be absorbed
  // without altering what the customer paid.
  const gross = Number((ctx.config as any)?.vat_included) === 1;

  let changed = 0;
  let zeroRatedExport = false;
  const blocked: string[] = [];

  for (const item of items) {
    if (isExplicitlyPriced(ctx, item)) continue;

    const r0 = Number(item.tax?.unit_amount) === 0 ? 0 : Number(item.tax?.value ?? 0);
    const r1 = ossRateFor(country, r0);
    if (r1 == null) continue;

    // A sale outside the EU is zero-rated as an export, and the engine names
    // the code whether or not it had to change the rate to get there. A line
    // that already arrived at 0% is still an export, and leaving the code to
    // whatever the connection happens to carry is how a French consumer sale
    // ended up stamped as one.
    if (r1 === 0) zeroRatedExport = true;

    if (r1 === r0) continue;

    if (!gross) {
      blocked.push(`a linha "${item.title}" foi cobrada a ${r0}% e o país do comprador impõe ${r1}%`);
      continue;
    }
    if (destination === "vendus" && !VENDUS_EXPRESSIBLE_RATES.has(r1)) {
      blocked.push(`o Vendus não sabe exprimir ${r1}% (${country}) e calcularia o IVA a partir de um código errado`);
      continue;
    }

    const k = (100 + r0) / (100 + r1);
    item.unit_price = round4(Number(item.unit_price) * k);
    item.unit_price_calculated = round4(Number(item.unit_price_calculated ?? item.unit_price) * k);
    if (typeof item.discount_allocation_amount === "number" && item.discount_allocation_amount > 0) {
      item.discount_allocation_amount = round4(item.discount_allocation_amount * k);
    }
    const net = (item.unit_price * (Number(item.quantity) || 0) - (item.discount_allocation_amount ?? 0))
      * (1 - (Number(item.discount?.percent) || 0) / 100);
    item.tax = {
      name: item.tax?.name || "VAT",
      value: r1,
      // Zero EXACTLY when the rate is zero: three destinations read this field
      // as "was any tax collected", not as an amount.
      unit_amount: r1 === 0 ? 0 : round2(net * r1 / 100),
    };
    changed++;
    if (r1 === 0) zeroRatedExport = true;
  }

  const exemptionCode = zeroRatedExport ? ossExemptionCode(ctx) : null;
  if (exemptionCode) {
    // Stamped onto the two per-run config objects the three destinations already
    // read, rather than threaded through three adapter signatures. Both are
    // parsed fresh per pipeline run, so this cannot leak into another sale.
    // ponytail: give createDraft an explicit exemptionCode argument if a fourth
    // destination ever needs it.
    (ctx.config as any).ix_exemption_reason = exemptionCode;
    if (ctx.destinationConfig) (ctx.destinationConfig as any).exemption_reason = exemptionCode;
  }

  return {
    enabled: true,
    country,
    changed,
    exemptionCode,
    holdReason: blocked.length
      ? `a taxa do país do comprador não pôde ser aplicada: ${blocked.join("; ")}`
      : null,
  };
}
