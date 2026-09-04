import type { IRequestConfig } from "../storage";
import type { Normalized } from "../api/normalize-shopify";
import type { PostV2CreditNotesData, PostV2InvoicesData } from "../api/ix/client";
import { validatePTNIF } from "./nif";
import { isCrossBorderEU, EU_COUNTRIES } from "./eu-countries";
import { buildExemptionMention } from "./exemption-mentions";
import type { ViesChecker } from "./vies";
import { type ReconcileLine } from "../adapters/reconcile";
import { documentReference } from "../services/document-references";
import { format } from "date-fns";

/** InvoiceXpress hard limit on the client name; longer values reject the document. */
const IX_CLIENT_NAME_MAX = 100;

/** Portuguese mobile ranges. Nine digits, same shape as a NIF — see inspectAddressTaxId. */
const PT_MOBILE_PREFIX = /^9[1236]/;

/** Outcome of reading a tax id out of an address line 2. See `inspectAddressTaxId`. */
export type Address2TaxId =
  | { kind: "none" }
  | { kind: "valid"; nif: string; field: string }
  | { kind: "invalid"; raw: string; field: string };

/**
 * Set on a build whose address line 2 held something meant to be a Portuguese
 * tax id that failed validation. The document is still produced — as a draft —
 * but must not be finalized or emailed to the customer until a human looks at
 * it. Carries the offending text so the merchant email can quote it back:
 * "encontrámos 500000001 na morada de entrega" is actionable, "NIF inválido"
 * is not.
 */
export type NifHold = {
  /** Something meant to be a PT tax id, written into an address line, that
   *  does not validate. */
  kind: "address_tax_id";
  /** The exact text read out of the address line, e.g. "500000001". */
  raw: string;
  /** Which field it came from, e.g. "shipping.address2". */
  field: string;
};

/** Human reason string persisted on processed_orders.hold_reason. */
export function nifHoldReason(hold: NifHold): string {
  return `nif_invalid: "${hold.raw}" em ${hold.field}`;
}

export type IxInvoice = NonNullable<PostV2InvoicesData["body"]>["invoice"];
export type IxCreditNote = NonNullable<PostV2CreditNotesData["body"]>["credit_note"];

/**
 * InvoiceXpress requires the client country as a full English name ("Portugal",
 * "Germany"), NOT an ISO code. Sending "PT" fails with `Country PT was not found`
 * (422), which the invoice endpoint surfaces as the cascading "Client is invalid /
 * Fiscal is invalid". Shopify already provides the full name in `billing_address.country`;
 * Stripe-source only has the ISO code, so map any bare 2-letter code to its English name.
 */
// IX validates the country against its own list of English names and rejects
// anything it doesn't recognise ("Country Macao was not found" → 422 → the whole
// document fails). A few names from Intl.DisplayNames don't match IX's list, so
// we override those specific ISO codes. Add new entries here as IX rejections
// surface (verified live: MO must be "Macau", not the Intl "Macao").
const IX_COUNTRY_OVERRIDE: Record<string, string> = {
  MO: "Macau",
};

function toIxCountryName(value: string): string {
  const v = (value || "").trim();
  if (v.length !== 2) return v; // already a full name (or empty)
  const cc = v.toUpperCase();
  if (IX_COUNTRY_OVERRIDE[cc]) return IX_COUNTRY_OVERRIDE[cc];
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(cc) || v;
  } catch {
    return v;
  }
}

export type ReverseChargeDecision =
  | { status: "apply"; countryCode: string; vatNumber: string }
  | { status: "skip" }
  | { status: "deferred"; countryCode: string; vatNumber: string };

export type AsyncInvoiceBuild =
  | { status: "ready"; invoice: IxInvoice; requestTaxExemptionReason: boolean; reverseCharge: boolean; nifHold?: NifHold }
  | { status: "deferred"; countryCode: string; vatNumber: string };

export interface IxProductOverride {
  tax_rate?: number;
  vat_inclusion?: "inc" | "exc";
  exemption_reason?: string;
  name_override?: string;
}

export class IxBuilder {
  private readonly config: IRequestConfig;
  private readonly viesChecker?: ViesChecker;
  private readonly overrides?: Map<string, IxProductOverride>;

  constructor(config: IRequestConfig, viesChecker?: ViesChecker, overrides?: Map<string, IxProductOverride>) {
    this.config = config;
    this.viesChecker = viesChecker;
    this.overrides = overrides;
  }

  // Same key shape as MoloniDestination.deriveProductReference so a single
  // overrides table works for both adapters. Shipping iff no SKU and no ids.
  private overrideKeyForLine(li: any): string {
    const sku = (li?.sku ?? "").toString().trim();
    if (sku) return sku.slice(0, 30);
    if (li?.variant_id) return `RIOKO-VARIANT-${li.variant_id}`.slice(0, 30);
    if (li?.product_id) return `RIOKO-PRODUCT-${li.product_id}`.slice(0, 30);
    return "RIOKO-SHIPPING";
  }

  // Book (ISBN) reduced-rate rule. When the merchant defines the synthetic
  // `RIOKO-ISBN-BOOK` override (tax_rate = e.g. 6), any line whose SKU is an
  // ISBN-13 (978…/979…) is billed at that rate. This lets a bookseller charge
  // books at 6% and everything else at the forced/collected rate WITHOUT a
  // per-title override for every ISBN in the catalog (thousands). A specific
  // per-SKU override still wins over this; and it only applies to merchants who
  // opt in by creating the RIOKO-ISBN-BOOK row, so other shops are unaffected.
  private isbnBookRate(li: any): number | undefined {
    const rate = this.overrides?.get("RIOKO-ISBN-BOOK")?.tax_rate;
    if (rate == null) return undefined;
    const sku = (li?.sku ?? "").toString().replace(/[-\s]/g, "");
    return /^97[89]\d{10}$/.test(sku) ? Number(rate) : undefined;
  }

  // IX refuses a document with a 0% line unless a razão de isenção travels with
  // it (measured live: HTTP 400 "Razão de isenção deve ter uma opção
  // selecionada"), so a zero rate here means the shop's configured exemption
  // code gets stamped automatically. That is right for a shop that genuinely
  // sells exempt (art. 53, exports, reverse charge) and WRONG for one that just
  // failed to resolve its rate — see assertForcedRateApplied, which stops a
  // forced-rate line ever reaching this point at zero.
  shouldRequestTaxExemptionReason(items: IxInvoice["items"]) {
    return items.some(item =>
      (typeof item.tax === "number"
        ? item.tax
        : item.tax.value) === 0
    );
  }

  /**
   * A shop that imposes a positive VAT rate has no exempt lines of that kind.
   * If one lands at 0% anyway, something upstream failed — and stamping the
   * shop's generic exemption code (M99) over it turns that failure into a
   * legally exempt invoice that nobody notices. That is exactly what happened
   * to Zoo de Lagos on 2026-08-02→05: 81 ticket sales (place of supply PT, 6%,
   * never exempt) went out at 0% VAT, €235.88 of IVA undeclared, each document
   * totalling less than the customer paid.
   *
   * Refusing here leaves the order visibly unbilled, which the sweep retries and
   * the digest reports — a loud failure instead of a quiet wrong document.
   * Explicit per-SKU overrides are exempt from this check: a merchant setting a
   * rate by hand is a decision, not a resolution failure.
   */
  private assertForcedRateApplied(
    rate: number,
    forced: number | null | undefined,
    kind: "produto" | "portes",
    lineName: string,
  ): void {
    if (forced == null || !(forced > 0) || rate !== 0) return;
    throw new Error(
      `Linha "${lineName}" ficou a 0% de IVA numa loja que impõe ${forced}% em ${kind}. `
      + `Recuso emitir um documento isento por falha de taxa — corrigir a configuração antes de faturar.`,
    );
  }

  buildInvoiceItemsFromRaw(rawOrder: any, opts?: { forceZeroTax?: boolean }): IxInvoice["items"] {
    const forceTaxProducts = this.config.force_tax_rate;
    const forceTaxShipping = this.config.force_shipping_tax_rate;
    const forceZeroTax = opts?.forceZeroTax === true;
    const shopifyIncluded = rawOrder?.taxes_included === true;
    const round4 = (n: number) => Math.round(n * 10000) / 10000;
    const ceil2 = (n: number) => Math.ceil(n * 100) / 100;

    // IX always treats `unit_price` and `discount_amount` as VAT-exclusive and
    // recomputes the gross by adding tax. It also clamps `unit_price` storage
    // to 2 decimals while preserving full precision on `discount_amount`. We
    // ceil `unit_price` to 2dp (so any rounding loss can be absorbed by a
    // small `discount_amount`) and emit a high-precision `discount_amount` so
    // IX's line subtotal lands exactly on Shopify's per-line target.
    const buildLine = (
      grossUnit: number,
      qty: number,
      grossLineDiscount: number,
      rate: number,
      tax: number,
      name: string,
      description?: string,
      lineIncluded?: boolean,
    ): IxInvoice["items"][number] | null => {
      if (qty <= 0 || grossUnit <= 0) return null;
      const effectiveIncluded = lineIncluded ?? shopifyIncluded;
      const factor = rate > 0 ? 1 + rate / 100 : 1;
      const unitNetExact = effectiveIncluded && rate > 0 ? grossUnit / factor : grossUnit;
      const targetLineGross = grossUnit * qty - grossLineDiscount;
      const targetLineNet = effectiveIncluded && rate > 0 ? targetLineGross / factor : targetLineGross;
      // Ceil to 2dp so any sub-cent precision left over is absorbed by a
      // positive `discount` percentage (IX rejects negative discounts).
      const unitNetSend = ceil2(unitNetExact);
      const lineSubtotalSend = unitNetSend * qty;
      // IX silently ignores `items[*].discount_amount` on POST. The only
      // per-line discount it honours is `discount` (percentage). We solve
      // for the percentage that makes `(unit_price * qty) * (1 - d/100)`
      // equal the line's target net subtotal.
      const rawPercent = lineSubtotalSend > 0
        ? (1 - targetLineNet / lineSubtotalSend) * 100
        : 0;
      // forceZeroTax zeroes the TAX (reverse-charge / exempt), NOT the discount:
      // the line must still net to what the buyer paid. With rate=0 above,
      // targetLineNet already equals the discounted gross, so this percentage
      // correctly re-targets it. (Dropping the discount here overcharged a
      // discounted reverse-charge order — the only caller of this path.)
      const discountPercent = round4(Math.max(0, rawPercent));
      const item: IxInvoice["items"][number] = {
        quantity: qty,
        tax,
        unit_price: unitNetSend,
        name,
        ...(description ? { description } : {}),
      };
      if (discountPercent > 0) {
        (item as any).discount = discountPercent;
      }
      return item;
    };

    const items: IxInvoice["items"] = [];

    const lineItems = Array.isArray(rawOrder?.line_items) ? rawOrder.line_items : [];
    for (const li of lineItems) {
      const quantity = Number(li?.quantity ?? 0);
      // Effective rate from collected tax, not declared rate. Shopify ships
      // `tax_lines[].rate` informationally even when `price=0` (B2B reverse
      // charge, art. 53 exempt seller, manually zeroed). Trusting `rate` would
      // double-tax. Sum `tax_lines[*].price` and only adopt the rate if any
      // tax was actually collected.
      const taxLinesArr = Array.isArray(li?.tax_lines) ? li.tax_lines : [];
      const taxCollected = taxLinesArr.reduce((acc: number, t: any) => acc + Number(t?.price ?? 0), 0);
      const declaredRate = Number(taxLinesArr[0]?.rate ?? 0) * 100;
      const shopifyRate = taxCollected > 0 ? declaredRate : 0;
      const grossUnit = Number(li?.price ?? 0);
      const allocations = Array.isArray(li?.discount_allocations) ? li.discount_allocations : [];
      const grossLineDiscount = allocations.reduce((acc: number, a: any) => acc + Number(a?.amount ?? 0), 0);

      // Per-SKU overrides: tax_rate replaces the effective rate; vat_inclusion
      // flips how we interpret grossUnit on a per-line basis.
      const override = this.overrides?.get(this.overrideKeyForLine(li));
      const lineIncluded = override?.vat_inclusion === "inc"
        ? true
        : override?.vat_inclusion === "exc"
          ? false
          : undefined; // fall back to shopifyIncluded inside buildLine

      // ONE effective rate must drive BOTH the VAT-inclusion extraction math and
      // the rate stamped on the IX line — if they diverge the reconcile guard
      // trips. Precedence: per-SKU override > merchant force_tax_rate > the rate
      // Shopify actually collected.
      //
      // Bug fixed here: the math rate used `shopifyRate` while the stamped tax
      // used `force_tax_rate`. On a tax-INCLUDED store that sets force_tax_rate
      // but where Shopify collected no tax (empty tax_lines — e.g. a bilheteira
      // priced gross at 17€ with 6% baked in), the math rate was 0 so the gross
      // was kept as net while 6% was stamped on top → IX total 72.08 vs paid
      // 68.00 → "Invoice total mismatch" drift, invoice never issued.
      // Precedence: per-SKU override > ISBN book rate (if SKU is an ISBN and the
      // merchant opted into RIOKO-ISBN-BOOK) > merchant force_tax_rate > collected.
      const effectiveRate = forceZeroTax
        ? 0
        : (override?.tax_rate != null
          ? Number(override.tax_rate)
          : (this.isbnBookRate(li) ?? (forceTaxProducts != null ? forceTaxProducts : shopifyRate)));
      const variantTitle = li?.variant_title ? ` / ${li.variant_title}` : "";
      const defaultName = `${li?.title ?? li?.name ?? "Item"}${variantTitle}`.slice(0, 200);
      const name = (override?.name_override ?? defaultName).slice(0, 200);
      const description = li?.sku ? `SKU: ${li.sku}`.slice(0, 200) : undefined;
      if (!forceZeroTax && override?.tax_rate == null) {
        this.assertForcedRateApplied(effectiveRate, forceTaxProducts, "produto", name);
      }
      const item = buildLine(grossUnit, quantity, grossLineDiscount, effectiveRate, effectiveRate, name, description, lineIncluded);
      if (item) items.push(item);
    }

    const shippingLines = Array.isArray(rawOrder?.shipping_lines) ? rawOrder.shipping_lines : [];
    for (const sl of shippingLines) {
      // Same effective-rate rule as product lines: trust collected tax, not
      // declared rate. Reverse-charge shipping reports rate but price=0.
      const shipTaxLines = Array.isArray(sl?.tax_lines) ? sl.tax_lines : [];
      const shipTaxCollected = shipTaxLines.reduce((acc: number, t: any) => acc + Number(t?.price ?? 0), 0);
      // The rate of the tax line that actually collected something, not
      // `tax_lines[0]`: Shopify orders these by rate, so a basket carrying a
      // 0%-rated article can put `{rate: 0, price: 0}` first and the whole
      // shipping would be read as untaxed.
      const shipCollectedRate = shipTaxCollected > 0
        ? Number(shipTaxLines.find((t: any) => Number(t?.price ?? 0) > 0)?.rate ?? 0) * 100
        : 0;
      const grossUnit = Number(sl?.price ?? 0);
      const allocations = Array.isArray(sl?.discount_allocations) ? sl.discount_allocations : [];
      const grossLineDiscount = allocations.reduce((acc: number, a: any) => acc + Number(a?.amount ?? 0), 0);
      // Same effective-rate consistency as product lines: the rate used for the
      // VAT-inclusion math must equal the rate stamped on the line, else the
      // reconcile guard trips. force_shipping_tax_rate > collected shipping rate.
      const shipEffectiveRate = forceZeroTax ? 0 : (forceTaxShipping != null ? forceTaxShipping : shipCollectedRate);
      const name = `Portes de envio${sl?.title ? ` — ${sl.title}` : ""}`.slice(0, 200);
      if (!forceZeroTax) this.assertForcedRateApplied(shipEffectiveRate, forceTaxShipping, "portes", name);
      // Shipping overrides keyed by RIOKO-SHIPPING — same semantics
      const shipOverride = this.overrides?.get("RIOKO-SHIPPING");
      const shipIncluded = shipOverride?.vat_inclusion === "inc"
        ? true
        : shipOverride?.vat_inclusion === "exc"
          ? false
          : undefined;

      // F-SHIP: mixed-rate shipping. On a basket with items at >1 VAT rate,
      // Shopify splits the shipping tax across those rates (e.g. a 12€ CTT line
      // with tax_lines [21%:1.57, 10%:0.45]). The single-rate path above would
      // stamp the WHOLE shipping at one rate and over/under-tax it (#4172:
      // +0.50€), so each taxed portion is sized from its own tax basis instead.
      //
      // One of those rates can be ZERO, and that is the case this missed for
      // months: a 25€ line on a basket holding one 0%-rated article arrives as
      // tax_lines [23%: 5.46, 0%: 0.00], meaning only 23.74€ of the shipping is
      // taxable. Splitting on `distinctShipRates.size > 1` counted the taxed
      // rates only, saw one, and stamped the whole 25€ at 23% — 0.29€ of VAT
      // the buyer never paid. On a short order the reconcile guard then refused
      // the document and the order sat unbilled (Angel #4799); on a long one
      // `absorbReconcileResidual` swallowed the same error and the invoice went
      // out with the VAT quietly shifted onto another line, which is worse.
      //
      // So: size every taxed portion from its tax basis, and give whatever is
      // left of the shipping its own 0% sub-line. That also recovers the few
      // cents the taxed bases leave short in the genuinely multi-rate case.
      const nonzeroShipTax = shipTaxLines.filter((t: any) => Number(t?.price ?? 0) > 0);
      const distinctShipRates = new Set(nonzeroShipTax.map((t: any) => Number(t?.rate ?? 0)));
      const effectiveShipIncluded = shipIncluded ?? shopifyIncluded;
      const taxedShipPortions = nonzeroShipTax
        .map((t: any) => ({ rate: Number(t?.rate ?? 0) * 100, taxAmt: Number(t?.price ?? 0) }))
        .filter((t: { rate: number; taxAmt: number }) => t.rate > 0 && t.taxAmt > 0)
        .map((t: { rate: number; taxAmt: number }) => ({ ...t, basisNet: t.taxAmt / (t.rate / 100) }));
      // `sl.price` carries VAT only where the store prices that way; the bases
      // above are always net, so bring both to net before subtracting.
      const shipNetTotal = effectiveShipIncluded ? grossUnit - shipTaxCollected : grossUnit;
      const untaxedShipNet = shipNetTotal - taxedShipPortions.reduce((acc: number, t: { basisNet: number }) => acc + t.basisNet, 0);
      // Half a cent: below that it is float noise from dividing by the rate,
      // above it is a real untaxed portion that has to appear on the document.
      const hasUntaxedShip = untaxedShipNet > 0.005;
      const splitShipping = taxedShipPortions.length > 0 && (distinctShipRates.size > 1 || hasUntaxedShip);
      if (!forceZeroTax && forceTaxShipping == null && grossLineDiscount === 0 && splitShipping) {
        for (const t of taxedShipPortions) {
          const portionGross = effectiveShipIncluded ? t.basisNet + t.taxAmt : t.basisNet; // buildLine wants gross when included, net when not
          const subName = `${name} (${t.rate % 1 === 0 ? t.rate : t.rate.toFixed(2)}%)`.slice(0, 200);
          const item = buildLine(portionGross, 1, 0, t.rate, t.rate, subName, undefined, effectiveShipIncluded);
          if (item) items.push(item);
        }
        if (hasUntaxedShip) {
          // Rate 0 either way, so the net remainder is also its gross.
          const item = buildLine(untaxedShipNet, 1, 0, 0, 0, `${name} (0%)`.slice(0, 200), undefined, effectiveShipIncluded);
          if (item) items.push(item);
        }
      } else {
        const item = buildLine(grossUnit, 1, grossLineDiscount, shipEffectiveRate, shipEffectiveRate, name, undefined, shipIncluded);
        if (item) items.push(item);
      }
    }

    this.absorbReconcileResidual(items, rawOrder, forceZeroTax, shopifyIncluded);
    return items;
  }

  // Tax-EXCLUDED multi-line orders (OSS baskets with several low-value lines,
  // often discounted) accumulate per-line 2dp rounding that drifts the summed IX
  // gross a few cents from Shopify's `total_price` — the amount the customer
  // actually PAID. Left alone this trips `reconcileOrThrow` (1¢) and the order is
  // never invoiced (observed live on Angel Piercings / 2d0604-3). Shopify's
  // total_price is the source of truth, so re-target the highest-gross line so the
  // summed IX total lands on what was paid (the per-line VAT split shifts by cents
  // on one line; the total and the total VAT stay correct).
  //
  // Scope is deliberately narrow: only the tax-EXCLUDED case (the 3 vat-included
  // clients reconcile to the cent already, so they're skipped → zero risk to
  // them), and only pure rounding noise — `|residual| <= 0.01·nLines + 0.10`,
  // which grows with line count and per-line discounts. Anything larger is a real
  // structural gap and is left to `reconcileOrThrow` to catch.
  //
  // The line is rebuilt with the SAME ceil2-unit + positive-discount mechanism
  // `buildLine` uses, so IX rounds it predictably and the discount is never
  // negative (which IX rejects).
  private absorbReconcileResidual(items: IxInvoice["items"], rawOrder: any, forceZeroTax: boolean, shopifyIncluded: boolean): void {
    if (forceZeroTax || shopifyIncluded || !Array.isArray(items) || items.length === 0) return;
    const target = Number(rawOrder?.total_price);
    if (!Number.isFinite(target) || target <= 0) return;
    const round4 = (n: number) => Math.round(n * 10000) / 10000;
    const ceil2 = (n: number) => Math.ceil(n * 100) / 100;
    const rateOf = (it: any) => (typeof it.tax === "number" ? it.tax : Number(it.tax?.value ?? 0));
    // IX sums FULL-PRECISION line grosses and rounds ONCE (verified live: returned
    // tax_amount is unrounded, total == round2(Σ unit·qty·(1-d/100)·(1+r/100))).
    // So compute the residual the same way and re-target the absorbing line in
    // full precision — never per-line-rounded — so IX's total lands on `paid`.
    const fullGross = (it: any) =>
      Number(it.unit_price) * Number(it.quantity) * (1 - Number(it.discount ?? 0) / 100) * (1 + rateOf(it) / 100);
    const expected = this.ixExpectedGross(items);
    const residual = Math.round((target - expected) * 100) / 100;
    if (residual === 0) return;
    if (Math.abs(residual) > 0.01 * items.length + 0.10) return; // structural, not rounding — let reconcile catch it

    // Highest-gross line absorbs the residual (smallest relative distortion).
    let k = 0, best = -Infinity;
    items.forEach((it, i) => { const g = fullGross(it); if (g > best) { best = g; k = i; } });
    const it: any = items[k];
    const rate = rateOf(it);
    const factor = rate > 0 ? 1 + rate / 100 : 1;
    const qty = Number(it.quantity);
    if (qty <= 0) return;
    let sumOthers = 0;
    items.forEach((x, i) => { if (i !== k) sumOthers += fullGross(x); });
    const targetKFull = target - sumOthers; // full gross line k must produce so round2(total) == paid
    if (targetKFull <= 0) return;
    const netNeeded = targetKFull / factor;      // pre-tax subtotal IX needs for line k
    const unit = ceil2(netNeeded / qty);         // ceil so unit*qty >= netNeeded → discount stays positive
    const base = unit * qty;
    if (base <= 0) return;
    const disc = round4(Math.max(0, (1 - netNeeded / base) * 100));
    it.unit_price = unit;
    if (disc > 0) it.discount = disc; else delete it.discount;
  }

  // The EXACT total InvoiceXpress computes from a set of items: sum the
  // full-precision per-line gross and round once. IX does NOT round per line
  // (verified live — returned `tax_amount` is unrounded), so the shared
  // per-line `computeExpectedGross` mis-predicts IX by a few cents on multi-line
  // orders. Every IX total prediction/reconciliation must use THIS model.
  private ixExpectedGross(items: IxInvoice["items"]): number {
    let total = 0;
    for (const it of items as any[]) {
      const rate = typeof it.tax === "number" ? it.tax : Number(it.tax?.value ?? 0);
      const disc = Number(it.discount ?? 0);
      const net = Number(it.unit_price) * Number(it.quantity) * (1 - disc / 100);
      total += net * (1 + rate / 100);
    }
    return Math.round(total * 100) / 100;
  }

  /** Convert IX-shaped items to the shared ReconcileLine shape. */
  private toReconcileLines(items: IxInvoice["items"]): ReconcileLine[] {
    return items.map((it: any) => ({
      name: it.name,
      quantity: Number(it.quantity),
      unit_price: Number(it.unit_price),
      tax_rate: typeof it.tax === "number" ? it.tax : Number(it.tax?.value ?? 0),
      discount_percent: Number(it.discount ?? 0),
    }));
  }

  // Compute the expected gross total that IX should arrive at from the items
  // we're about to send. Uses IX's actual round-once model (see ixExpectedGross).
  computeIxExpectedTotal(items: IxInvoice["items"]): number {
    return this.ixExpectedGross(items);
  }

  // Throws if our planned IX total drifts from the amount actually paid by more
  // than one cent. Caller catches and aborts the IX call rather than ship a
  // wrongly-totalled invoice. Uses IX's round-once model so the guard agrees with
  // what IX will actually compute (the shared per-line `reconcileTotalOrThrow`
  // mis-predicted IX and blocked good multi-line orders).
  reconcileOrThrow(rawOrder: any, items: IxInvoice["items"]): void {
    if (!rawOrder) return;
    const shopifyTotal = Number(rawOrder?.total_price);
    if (!Number.isFinite(shopifyTotal) || shopifyTotal <= 0) return;
    this.reconcileIxOrThrow(shopifyTotal, items, "Shopify→IX");
  }

  /** Round-once reconcile against the paid amount; throws the same
   * "Invoice total mismatch" shape the alerting/incident path parses. */
  reconcileIxOrThrow(paid: number, items: IxInvoice["items"], context: string): void {
    if (!Number.isFinite(paid) || paid <= 0) return;
    const expected = this.ixExpectedGross(items);
    const drift = Math.abs(expected - paid);
    if (drift > 0.01) {
      const breakdown = this.toReconcileLines(items);
      throw new Error(
        `[${context}] Invoice total mismatch: paid=${paid.toFixed(2)} expected=${expected.toFixed(2)} drift=${drift.toFixed(2)}. Lines=${JSON.stringify(breakdown)}`,
      );
    }
  }

  buildInvoiceItems(normalizedItems: Normalized["order"]["items"], opts?: { forceZeroTax?: boolean }): IxInvoice["items"] {
    const forceTaxProducts = this.config.force_tax_rate;
    const forceTaxShipping = this.config.force_shipping_tax_rate;
    const forceZeroTax = opts?.forceZeroTax === true;
    return normalizedItems.map(item => {
      const isShipping = !item.product_id && !item.variant_id;
      const name = isShipping
        ? `Portes de envio${item.title ? ` — ${item.title}` : ""}`.slice(0, 200)
        : (item.variant_title
          ? `${item.title} / ${item.variant_title}`.slice(0, 200)
          : item.title.slice(0, 200));
      const description = isShipping
        ? undefined
        : (item.sku ? `SKU: ${item.sku}`.slice(0, 200) : undefined);
      const forceTax = isShipping ? forceTaxShipping : forceTaxProducts;
      const tax = forceZeroTax
        ? 0
        : (forceTax != null
          ? forceTax
          : (item.tax.unit_amount === 0 ? 0 : item.tax.value));
      if (!forceZeroTax) {
        this.assertForcedRateApplied(Number(tax), forceTax, isShipping ? "portes" : "produto", name);
      }
      const allocation = !forceZeroTax && typeof item.discount_allocation_amount === "number" && item.discount_allocation_amount > 0
        ? Math.round(item.discount_allocation_amount * 100) / 100
        : 0;
      return {
        quantity: item.quantity,
        tax,
        unit_price: item.unit_price,
        name,
        ...(description ? { description } : {}),
        ...(allocation > 0
          ? { discount_amount: allocation }
          : (item?.discount?.percent ? { discount: item.discount.percent } : {})),
      };
    });
  }

  pickInvoiceAddress(normalized: Normalized) {
    // Null-safe: guest / POS orders can arrive with customer = null. Reading
    // customer.default_address on null throws a TypeError that aborts the whole
    // invoice build (order never invoiced). Default to an empty object so the
    // spreads below simply contribute nothing.
    const customer = normalized.order.customer ?? ({} as NonNullable<Normalized["order"]["customer"]>);

    return {
      ...normalized.order.shipping_address ?? {},
      ...customer.default_address ?? {},
      ...normalized.order.billing_address ?? {},
      ...customer.address ?? {},
    };
  }

  // buildInvoiceClient(normalized: Normalized): IxInvoice["client"] {
  //   const customer = normalized.order.customer;
  //   const address = this.pickInvoiceAddress(normalized);

  //   return {
  //     name: customer.name ?? undefined,
  //     email: customer.email ?? undefined,
  //     address: address.address1 ?? undefined,
  //     city: address.city ?? undefined,
  //     country: address.country_code ?? undefined,
  //     fiscal_id: address.address2 ?? undefined,
  //     phone: address.phone ?? undefined,
  //     postal_code: address.zip ?? undefined,
  //   };
  // }

  // Detects "Shopify already concluded this is reverse-charge" without running
  // VIES. Set by Shopify when the customer presents a valid intra-EU NIF or
  // when the merchant marks the customer tax-exempt under EU rules. Trusting
  // this avoids re-confirming via VIES on the raw path (the async path still
  // performs the 7-signal + VIES check when the merchant opted in).
  private detectShopifyReverseCharge(rawOrder: any): boolean {
    const arr = rawOrder?.customer?.tax_exemptions;
    if (!Array.isArray(arr)) return false;
    return arr.some((tag: any) => String(tag ?? "").toUpperCase().includes("REVERSE_CHARGE"));
  }

  /**
   * `opts.fiscal` replaces the shop-wide exemption code with one decided per
   * sale (see src/ix/fiscal-classification.ts). It is applied ONLY to a
   * document that already has a 0%-VAT line — the caller does not get to stamp
   * an exemption on a taxed document — and it does not touch the amounts, so a
   * buyer who paid VAT is still invoiced for what they paid. Absent, everything
   * below behaves exactly as it did before the override existed.
   */
  createInvoiceFromNormalizedOrder(
    normalized: Normalized,
    opts?: { fiscal?: { exemptionCode: string | null; mention: string } },
  ) {
    // Address line 2 carries something clearly intended as a Portuguese tax id
    // that does not validate. We still produce the document — withholding it
    // entirely left paid orders uninvoiced and the merchant chasing them — but
    // WITHOUT that number (buildInvoiceClient only ever uses an address-line
    // tax id when it validates), and we flag the build. The caller creates it
    // as a draft, skips finalize + the customer email, and tells the merchant.
    const addressTaxId = this.inspectAddressTaxId(normalized);
    let nifHold: NifHold | undefined = addressTaxId.kind === "invalid"
      ? { kind: "address_tax_id", raw: addressTaxId.raw, field: addressTaxId.field }
      : undefined;

    const client = this.buildInvoiceClient(normalized);
    const usingRawPath = !!normalized.raw_order;
    const items = usingRawPath
      ? this.buildInvoiceItemsFromRaw(normalized.raw_order)
      : this.buildInvoiceItems(normalized.order.items);
    // Never POST an empty document — IX rejects it and, more importantly, a
    // zero-item build signals a normalization gap we must not paper over.
    if (items.length === 0) {
      throw new Error(`Invoice for Order #${normalized.order.order_number} has no line items — refusing to POST an empty document`);
    }
    const requestTaxExemptionReason = this.shouldRequestTaxExemptionReason(items);
    const shopifyReverseCharge = usingRawPath && this.detectShopifyReverseCharge(normalized.raw_order);

    if (usingRawPath) {
      this.reconcileOrThrow(normalized.raw_order, items);
    } else {
      // Non-raw fallback path (the raw Shopify fetch failed, so we lost discount
      // enrichment). buildInvoiceItems emits items[].discount_amount, which IX
      // SILENTLY IGNORES on POST — so a discounted order would ship with the
      // discount dropped and a gross > amount paid, and until now this path had
      // NO reconcile guard. Reconcile against the normalized paid total too:
      // toReconcileLines does not carry discount_amount (it only honours the
      // `discount` percentage), so computeExpectedGross matches exactly what IX
      // will compute. A non-discounted order still passes (no regression); a
      // discounted one throws → the queue retries (raw fetch usually recovers)
      // instead of issuing a wrong invoice.
      const paid = Number(normalized.order?.total ?? normalized.order?.total_calculated);
      if (Number.isFinite(paid) && paid > 0) {
        this.reconcileIxOrThrow(paid, items, "Shopify→IX (non-raw fallback)");
      }
    }

    // Reverse-charge: prefer M16 (RITI art. 14.º) and stamp the mandatory
    // "IVA - autoliquidação" mention. Falls back to the merchant-configured
    // generic exemption reason if neither flag matches.
    const baseReason = this.config.ix_exemption_reason ?? undefined;
    // A per-sale classification, when the caller made one, outranks both: it
    // looked at where the buyer is and whether their VAT number is real, which
    // is more than either of these knows. `shopifyReverseCharge` still wins
    // over it, because that one is Shopify stating the sale IS reverse-charge.
    const classifiedReason = opts?.fiscal ? (opts.fiscal.exemptionCode ?? undefined) : undefined;
    const rcReason = shopifyReverseCharge
      ? (this.config.ix_b2b_exemption_reason ?? "M16")
      : (classifiedReason ?? baseReason);
    const noteRaw = (normalized.order?.note ?? "").trim();
    const rcMention = shopifyReverseCharge ? "IVA - autoliquidação (Art. 196.º Directiva IVA UE)" : "";
    // When the shop opts in, stamp the exemption code's bilingual legal mention.
    // Only on the generic-exemption path (exempt, non reverse-charge); rcReason
    // equals baseReason there, so the mention matches the code actually sent.
    // Placed first so the 200-char cap never truncates the mandatory fiscal text.
    // A classified document always states its reason, without waiting for
    // `ix_stamp_exemption_note`: naming the article is what makes an exempt
    // invoice legible to a customs officer or a foreign buyer's accountant, and
    // a shop that asked for per-sale classification is by definition selling
    // into places that need it. The opt-in flag still governs the shop-wide
    // path, where the mention is a convenience rather than the point.
    const exemptionMention =
      requestTaxExemptionReason && !shopifyReverseCharge
        ? (opts?.fiscal?.mention
          || (this.config.ix_stamp_exemption_note === 1 ? buildExemptionMention(rcReason) : ""))
        : "";
    // The merchant's own standing note (VAT scheme wording, licence number, a
    // fixed legal reference) goes last of the configured texts: the mandatory
    // fiscal mentions come first so the 200-char cap eats this instead of them.
    const customNote = (this.config.custom_invoice_note ?? "").trim();
    const obsCombined = [exemptionMention, noteRaw, rcMention, customNote]
      .filter(Boolean).join(" | ").slice(0, 200);

    const invoice: IxInvoice = {
      client,
      items,
      reference: documentReference(normalized.order),
      ...obsCombined ? { observations: obsCombined } : {},
      date: normalized.order.created_at,
      due_date: normalized.order.created_at,
      tax_exemption_reason: requestTaxExemptionReason ? rcReason : undefined,
      ...this.config.ix_retention_enabled === 1
        && typeof this.config.ix_retention === "number"
        && this.config.ix_retention > 0
        ? { retention: this.config.ix_retention.toFixed(2) }
        : {},
      // global_discount intentionally omitted on the raw path — per-line
      // discount_amount fully encodes every Shopify discount shape and IX's
      // own global_discount has no targeting (would double-discount shipping).
      ...(!usingRawPath && normalized.order?.global_discount
        ? {
          global_discount: {
            value: normalized.order.global_discount.percent,
            value_type: "percentage"
          }
        } : {})
    }

    return { invoice, requestTaxExemptionReason, nifHold };
  }

  buildInvoiceClient(normalized: Normalized): IxInvoice["client"] {
    let nif: string | null = this.extractAndValidateNIF(normalized);
    const order = normalized.order;
    // Foreign-VAT fallback: when no PT NIF found, try the EU-prefixed
    // candidates from the same fields (billing_address.company,
    // note_attributes, note). Picks the candidate matching the buyer's
    // billing country first, then any other. Essential for B2B intra-EU
    // (reverse charge) where IX needs a fiscal_id stamped to honour M16.
    // Address line 2, under the explicit rule: a usable tax id there is used,
    // plain address text is ignored. (`invalid` never reaches here — the build
    // is refused upstream in createInvoiceFromNormalizedOrder.)
    if (!nif) {
      const fromAddress = this.inspectAddressTaxId(normalized);
      if (fromAddress.kind === "valid") nif = fromAddress.nif;
    }

    if (!nif) {
      const euVat = this.pickEuVatCandidate(normalized);
      // A VAT whose country prefix contradicts the billing country is NOT
      // stamped: IX validates the PAIR, and a French VAT on an address that
      // says Portugal is refused outright ("Contribuinte não é válido"),
      // taking the whole document with it.
      //
      // The document is still issued, and normally — not held. The pairing is
      // ordinary rather than suspicious: someone French who moves to Portugal
      // keeps their French number and updates their address, and holding every
      // such sale for review would be a queue that never empties. What cannot
      // happen is the number going onto a Portuguese document as the fiscal
      // id, so it is left off and the sale is invoiced as any other.
      if (euVat && !euVat.mismatched) nif = euVat.vat;
    }

    // A Portuguese client's fiscal_id is nine bare digits. The EU fallback
    // prefixes the country code, which turned real NIFs into "PT515640158" —
    // accepted by IX but the wrong shape on a domestic document. Unwrap it.
    if (nif && /^PT\d{9}$/i.test(nif) && validatePTNIF(nif.slice(2))) {
      nif = nif.slice(2);
    }

    const customerName = (order.customer?.name || "").trim();
    const billingName = (order.billing_address?.name || "").trim();
    const address = this.pickInvoiceAddress(normalized);

    // The buyer's address, in the order Shopify actually fills these in.
    // `customer.email` alone is not enough: a guest checkout can arrive with
    // `customer: null` while the address the shopper typed sits on the order's
    // own `email` / `contact_email`. Reading only the customer object meant such
    // an order produced an IX client with no email at all — and an invoice we
    // can never send anywhere. (POS counter sales legitimately have none of the
    // three; those stay empty and are skipped by the sender.)
    const email = [
      order.customer?.email,
      (normalized as any).raw_order?.email,
      (normalized as any).raw_order?.contact_email,
      (order as any).email,
      (order as any).contact_email,
    ].map(v => String(v ?? "").trim()).find(v => v.length > 0) ?? "";

    // Shopify customer profiles are often first-name-only while the checkout
    // addresses carry the full name. When the resolved name has no surname,
    // graft it from billing/shipping — but only when that address's first
    // token matches the bare name (accent/case-insensitive), so a gift
    // recipient's surname is never borrowed. No match → keep the bare name.
    const enrichWithSurname = (first: string): string => {
      // strips combining diacritics (U+0300–U+036F) so "Érica" matches "Erica"
      const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
      const sources = [order.billing_address, order.shipping_address, order.customer?.default_address];
      for (const addr of sources) {
        if (!addr) continue;
        const full = String(addr.name || `${addr.first_name ?? ""} ${addr.last_name ?? ""}`).trim();
        const tokens = full.split(/\s+/).filter(Boolean);
        if (tokens.length >= 2 && fold(tokens[0]) === fold(first)) {
          return [first, ...tokens.slice(1)].join(" ");
        }
      }
      return first;
    };

    let resolvedName = customerName || billingName;
    if (resolvedName && !/\s/.test(resolvedName)) resolvedName = enrichWithSurname(resolvedName);
    const isPosMode = this.config.pos_mode === 1;

    let name: string;

    if (isPosMode) {
      // POS mode: full fiscal name matrix (only for clients like Benedita using POS without customer names)
      // 1. Real name → use it
      // 2. No name + NIF → "NIF XXXXXXXXX" (unique fiscal identifier, re-usable across purchases)
      // 3. No name + email → email username
      // 4. Nothing → "Consumidor Final"
      if (resolvedName) {
        name = resolvedName;
      } else if (nif) {
        name = `NIF ${nif}`;
      } else if (email) {
        name = email.split("@")[0].replace(/[._-]/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
      } else {
        // name = `Consumidor Final ${format(new Date(), "dd/MM/yyyy HH:mm:ss")}`;
        name = `Consumidor Final`;
      }
    } else {
      // Standard mode: Use real name if available.
      // Special case: if no NIF is provided, and the name is generic/missing, use "Consumidor Final"
      const isGeneric = !resolvedName || ["client", "unknown"].includes(resolvedName.toLowerCase());
      if (!nif && isGeneric) {
        // name = `Consumidor Final ${format(new Date(), "dd/MM/yyyy HH:mm:ss")}`;
        name = `Consumidor Final`;
      } else {
        // name = resolvedName || `Consumidor Final ${format(new Date(), "dd/MM/yyyy HH:mm:ss")}`;
        name = resolvedName || `Consumidor Final`;
      }
    }

    // Prefer the full country NAME (Shopify provides it); fall back to the code.
    // toIxCountryName converts any leftover ISO code (e.g. Stripe-source) to the
    // name IX requires — sending "PT" is rejected as "Country PT was not found".
    const rawCountry = String(order.billing_address?.country || order.billing_address?.country_code || "").trim();

    // Billing zip first (same source as city/country), merged-address fallback.
    // pickInvoiceAddress spreads can override a real zip with "" from a later
    // empty address, so resolve here instead of trusting the merge order.
    const postalCode = String(order.billing_address?.zip || address.zip || "").trim();

    // InvoiceXpress caps the client name at 100 characters and rejects the whole
    // document past it ("Nome é demasiado longo"), so the order never invoices at
    // all. Trim to the last word boundary that fits rather than cutting a word in
    // half, and drop any trailing separator. The NIF is already extracted above,
    // so nothing fiscal is lost when a pasted tax number falls off the end.
    if (name.length > IX_CLIENT_NAME_MAX) {
      const cut = name.slice(0, IX_CLIENT_NAME_MAX);
      const lastSpace = cut.lastIndexOf(" ");
      name = (lastSpace > IX_CLIENT_NAME_MAX * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;.\-]+$/, "");
    }

    return {
      name,
      email,
      fiscal_id: nif ?? undefined,
      code: String(order.customer?.id || order.id),
      address: address.address1,
      postal_code: postalCode || undefined,
      city: order.billing_address?.city,
      country: toIxCountryName(rawCountry),
      phone: (order.customer?.phone ?? order.billing_address?.phone) ?? undefined
    };
  }

  /**
   * What, if anything, the customer wrote into an address line 2.
   *
   * Three outcomes, matching the rule we operate under:
   *   • `none`    — the field is ordinary address text ("Lote 1", "Silva",
   *                 "4º andar"). Ignore it completely. This is the common case
   *                 and the one that used to produce fiscal_id="SILVA".
   *   • `valid`   — it holds a usable tax id: a checksum-valid PT NIF, or, for
   *                 a non-PT buyer, a foreign id we pass through untouched
   *                 (IX does not checksum those; an Italian 11-digit partita
   *                 IVA is perfectly legitimate and must not be rejected).
   *   • `invalid` — it is unmistakably *meant* to be a tax id (a 9+ digit run,
   *                 or an EU-prefixed VAT) from a PT buyer, yet fails the PT
   *                 checksum. The document is issued as a DRAFT without that
   *                 number and the merchant is emailed (see `NifHold`).
   *
   * Note on VIES: it is deliberately NOT consulted for a Portuguese NIF. VIES
   * only knows numbers registered for intra-EU operations, so an ordinary
   * consumer's NIF — the overwhelming majority of B2C orders — comes back
   * `valid: false` there. The mod-11 checksum is the only correct test for PT.
   * Non-PT EU VAT numbers DO go through VIES, on the reverse-charge path
   * (`resolveReverseCharge`), which is where that answer is meaningful.
   *
   * Caveat worth knowing: a Portuguese mobile number typed into address line 2
   * is also a bare 9-digit run. We recognise the mobile prefixes and treat
   * those as ordinary text; anything else that fails the checksum drafts the
   * document, since we cannot tell a typo'd NIF from an unusual phone number.
   */
  inspectAddressTaxId(normalized: Normalized): Address2TaxId {
    const order = normalized.order;
    const buyerCC = String(order.billing_address?.country_code ?? "").trim().toUpperCase();
    const isPortugueseOrUnknown = buyerCC === "" || buyerCC === "PT";

    const sources: Array<{ field: string; value: unknown }> = [
      { field: "billing.address2", value: order.billing_address?.address2 },
      { field: "shipping.address2", value: (order as any).shipping_address?.address2 },
    ];

    let firstClaim: { field: string; token: string } | null = null;

    for (const { field, value } of sources) {
      const raw = String(value ?? "").trim();
      if (!raw) continue;

      // Bare digit runs, tolerating the separators people actually type
      // ("123 456 789", "123.456.789"). Anything shorter than 9 digits is a
      // door number or a postal code, never a tax id.
      for (const m of raw.matchAll(/\d[\d .\-]{7,}\d/g)) {
        const digits = m[0].replace(/\D/g, "");
        if (digits.length < 9) continue;
        if (digits.length === 9 && validatePTNIF(digits)) return { kind: "valid", nif: digits, field };
        // Foreign buyer: their national id has its own length and checksum —
        // pass it through rather than judging it by Portuguese rules.
        if (!isPortugueseOrUnknown) return { kind: "valid", nif: digits, field };
        // A Portuguese mobile number is also nine digits, and people put their
        // phone in the address line constantly. When it starts with a mobile
        // prefix AND fails the NIF checksum it is a phone, not a mistyped tax
        // id — treat it as ordinary address text instead of holding the order.
        // (A real NIF in the 9xx range still passes the checksum above.)
        if (PT_MOBILE_PREFIX.test(digits)) continue;
        firstClaim ??= { field, token: digits };
      }

      // Country-prefixed EU VAT ("PT123456789", "ESB12345678"). The country
      // code must be a real member state and the remainder must actually carry
      // digits — that pair of checks is what stops "SILVA" being read as
      // SI + LVA, which is how address words became fiscal ids.
      for (const m of raw.toUpperCase().matchAll(/\b([A-Z]{2})([A-Z0-9]{5,13})\b/g)) {
        const [, cc, rest] = m;
        if (!EU_COUNTRIES.has(cc)) continue;
        if ((rest.match(/\d/g) ?? []).length < 5) continue;
        if (cc === "PT") {
          const digits = rest.replace(/\D/g, "");
          if (validatePTNIF(digits)) return { kind: "valid", nif: digits, field };
          firstClaim ??= { field, token: cc + rest };
          continue;
        }
        return { kind: "valid", nif: cc + rest, field };
      }
    }

    if (firstClaim) return { kind: "invalid", raw: firstClaim.token, field: firstClaim.field };
    return { kind: "none" };
  }

  extractAndValidateNIF(normalized: Normalized): string | null {
    const candidates: string[] = [];
    // Candidates that came from an explicitly NIF/VAT-labeled field, kept apart
    // from bare 9-digit numbers scraped out of free text (notes/address/phone),
    // which must never be stamped as a fiscal_id for PT.
    const labeled: string[] = [];
    const order = normalized.order;

    // 1. Extract from note_attributes (Dedicated NIF/VAT fields from Shopify apps)
    // Matches names like "NIF", "VAT", "NIF/VAT", "NIF do Cliente", "Tax ID", "VAT ID",
    // "fiscal_id", "IVA", "TVA", "TIN", etc. (substring match, whitespace-stripped).
    // Note: `vat` already matches vat_id/vatnumber; `fiscal` matches fiscal_id; `tax`
    // matches tax_id/taxnumber/taxid. The extras below cover non-substring acronyms
    // used in other EU countries and globally.
    if (order.note_attributes && Array.isArray(order.note_attributes)) {
      const keywords = [
        "nif", "vat", "contribuinte", "fiscal", "tax", "tin",
        "iva",   // Italian / Spanish VAT
        "tva",   // French / Belgian / Luxembourgish VAT
        "ust",   // German Umsatzsteuer
        "mwst",  // Mehrwertsteuer (DE/AT/CH VAT)
        "ein",   // US Employer Identification Number
        "cif",   // Spanish company tax ID
      ];
      for (const attr of order.note_attributes) {
        if (!attr || attr.value == null) continue;
        const name = String(attr.name ?? "").toLowerCase().replace(/\s+/g, "");
        const value = String(attr.value);
        const nameMatches = keywords.some(k => name.includes(k));
        if (nameMatches) {
          const clean = value.replace(/\D/g, "");
          if (clean.length >= 9) { candidates.push(clean.slice(-9)); labeled.push(clean.slice(-9)); }
        } else {
          const matches = value.match(/\b\d{9}\b/g);
          if (matches) candidates.push(...matches);
        }
      }
    }

    // 4. Extract from General Order Note
    if (order.note) {
      console.log(`[NIF] Checking Order Note: ${order.note.trim()}`);
      const matches = String(order.note.trim()).match(/\d{9}/g);
      if (matches) {
        console.log(`[NIF] Found matches in note: ${matches.join(", ")}`);
        candidates.push(...matches);
      }
    }

    // 5. Extract from the address fields the buyer actually fills in.
    //
    // Both addresses, not just billing. Portuguese shoppers routinely type
    // their NIF into the *delivery* address' "Apartamento, andar…" box, and a
    // Shopify order without a separate billing address keeps that value only on
    // shipping_address. Reading billing alone is why merchants saw invoices
    // issued with no NIF at all while the number was sitting in the payload.
    //
    // Maximal digit runs, not \b\d{9}\b: customers write "NIF216010993" with no
    // separator, and a word boundary needs a non-word char before the digits.
    // That miss is what pushed the value into the EU-VAT fallback, which then
    // read it as NI + F216010993. Taking whole runs and keeping the ones that
    // are exactly nine digits captures the NIF and ignores longer ids (an
    // 11-digit Italian VAT is not a sliding window of PT NIFs).
    const ninesIn = (s: unknown): string[] =>
      [...String(s ?? "").matchAll(/\d+/g)].map(m => m[0]).filter(d => d.length === 9);

    const addrSources = [order.billing_address, (order as any).shipping_address];
    for (const addr of addrSources) {
      if (!addr) continue;
      // `name` included deliberately: business buyers routinely paste company
      // name + NIF into the name box ("… UNIPESSOAL LDA 519227921"). The number
      // still has to pass the PT checksum below, so a house number or a phone
      // in a name cannot become a fiscal id.
      for (const field of [addr.company, addr.address2, addr.name] as Array<string | undefined>) {
        candidates.push(...ninesIn(field));
      }
    }
    candidates.push(...ninesIn(order.customer?.name));
    // Some merchants keep the NIF on the customer record rather than the order.
    candidates.push(...ninesIn((order.customer as any)?.note));

    // 6. Validate candidates for Portuguese algorithm
    for (const nif of candidates) {
      if (validatePTNIF(nif)) return nif;
    }

    // 7. No PT-valid NIF. Do NOT blindly stamp a random 9-digit number as the
    //    fiscal_id: InvoiceXpress validates it against the (PT) country and
    //    rejects the ENTIRE client with "Fiscal is invalid" → no invoice at all.
    //    A bare 9-digit scraped from notes/address/phone is almost always a phone
    //    or postal code, not a NIF. For PT (and unknown country, which IX treats
    //    as PT) omit it → the client falls back to "Consumidor Final". Only for an
    //    explicitly non-PT buyer do we keep a value the customer typed into a
    //    NIF/VAT-labeled field (foreign fiscal IDs can't pass the PT checksum;
    //    letter-prefixed EU VATs are handled by extractEuVatCandidates).
    const buyerCC = String(order.billing_address?.country_code ?? "").trim().toUpperCase();
    const isPortugueseOrUnknown = buyerCC === "" || buyerCC === "PT";
    if (!isPortugueseOrUnknown && labeled.length > 0) return labeled[0];

    return null;
  }

  /**
   * The EU VAT the client would carry, and whether its country prefix
   * contradicts the buyer's billing country.
   *
   * `extractEuVatCandidates` reads the company field, the notes and the order
   * attributes — everywhere a buyer might paste a tax number. When none of
   * them matches the billing country we used to stamp the first one anyway,
   * and a French VAT on a client IX is told lives in Portugal comes back as
   * "Contribuinte não é válido": the whole document refused, the order left
   * unbilled, no email to anyone (Angel #4783, 325.55€ stuck since 12/08).
   *
   * IX validates the PAIR, so there is nothing to guess our way out of — either
   * the address is wrong or the number is, and only the merchant knows which.
   * The caller turns this into a draft plus a message rather than a silence.
   *
   * An unstated billing country counts as Portugal, which is how IX files it.
   */
  private pickEuVatCandidate(normalized: Normalized): { vat: string; mismatched: boolean } | null {
    const buyerCC = String(normalized.order.billing_address?.country_code ?? "").trim().toUpperCase();
    const candidates = this.extractEuVatCandidates(normalized);
    if (candidates.length === 0) return null;
    const matching = candidates.find(c => c.countryCode === (buyerCC || "PT"));
    const chosen = matching ?? candidates[0];
    return { vat: `${chosen.countryCode}${chosen.vatNumber}`, mismatched: !matching };
  }

  // Pulls EU VAT candidates (country-code prefixed) from the same fields the
  // NIF extractor reads. Used by the reverse-charge gate so non-PT EU VATs
  // like "ESB12345678" or "DE123456789" are picked up — the PT extractor only
  // captures 9-digit strings, so it would miss letter-prefixed formats.
  extractEuVatCandidates(normalized: Normalized): Array<{ countryCode: string; vatNumber: string }> {
    const out: Array<{ countryCode: string; vatNumber: string }> = [];
    const seen = new Set<string>();
    // The two guards the old regex lacked, enforced here so every caller gets
    // them: the prefix must be a real member state, and the number must carry
    // enough digits to be a VAT number at all. Without these, "LASALLE College"
    // yields LA+SALLE and "NIF216010993" yields NI+F216010993 — both of which
    // were stamped onto real invoices as the customer's tax id.
    const push = (cc: string, num: string) => {
      const ccU = cc.toUpperCase();
      if (!EU_COUNTRIES.has(ccU)) return;
      if ((num.match(/\d/g) ?? []).length < 5) return;
      // A Portuguese candidate has exactly one definition of correct, and we
      // can check it here rather than shipping it to IX. Without this, a PT
      // buyer whose company field held a checksum-failing 9-digit number came
      // out as "PT131262550" on the invoice.
      if (ccU === "PT" && !validatePTNIF(num.replace(/\D/g, ""))) return;
      const key = `${ccU}:${num}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ countryCode: ccU, vatNumber: num });
    };

    const order = normalized.order;
    const buyerCC = String(order.billing_address?.country_code ?? "").trim().toUpperCase();

    // 9-digit NIF combined with billing country (PT/DE/ES with digit-only VATs).
    const ptNif = this.extractAndValidateNIF(normalized);
    if (ptNif && buyerCC) push(buyerCC, ptNif);

    // EU-prefix regex. Two guards that were missing and cost us 200 documents:
    // the prefix must be a real member-state code (otherwise "SILVA" parses as
    // SI + LVA) and the remainder must carry at least five digits (otherwise
    // any capitalised word qualifies). A VAT number without digits is not a
    // VAT number. Final shape is still confirmed by VIES downstream.
    const VAT_RE = /\b([A-Z]{2})([A-Z0-9]{5,13})\b/g;
    const sources: string[] = [];
    if (order.note_attributes && Array.isArray(order.note_attributes)) {
      for (const a of order.note_attributes) {
        if (a?.value != null) sources.push(String(a.value));
      }
    }
    if (order.note) sources.push(String(order.note));
    if (order.billing_address?.company) sources.push(String(order.billing_address.company));
    if (order.billing_address?.address2) sources.push(String(order.billing_address.address2));

    for (const s of sources) {
      const up = s.toUpperCase();
      for (const m of up.matchAll(VAT_RE)) push(m[1], m[2]);
    }

    // Bare-format VAT/NIF/DNI/CIF (no country prefix) combined with the
    // billing country. Restricted to fields where merchants typically jot
    // foreign tax IDs (company, note_attributes) — NOT note/address2 which
    // tend to contain phone fragments and other noise.
    if (buyerCC) {
      const bareSources: string[] = [];
      if (order.billing_address?.company) bareSources.push(String(order.billing_address.company));
      if (order.note_attributes && Array.isArray(order.note_attributes)) {
        for (const a of order.note_attributes) {
          if (a?.value != null) bareSources.push(String(a.value));
        }
      }
      // ES DNI 8d+L, ES NIE L+7d+L, ES CIF L+7d+char, FR/IT 11d, DE/NL 9d.
      const BARE_RE = /\b([A-Z]?\d{7,11}[A-Z0-9]?)\b/g;
      for (const s of bareSources) {
        const up = s.toUpperCase();
        for (const m of up.matchAll(BARE_RE)) {
          const v = m[1];
          if (/[A-Z]/.test(v) || v.length >= 9) push(buyerCC, v);
        }
      }
    }

    return out;
  }

  // 7-signal gate. Returns "apply" only if VIES confirms; "deferred" if VIES
  // is unreachable (caller queues for retry); "skip" for everything else.
  async resolveReverseCharge(normalized: Normalized): Promise<ReverseChargeDecision> {
    if (this.config.b2b_reverse_charge !== 1) return { status: "skip" };
    if (this.config.oss_enabled !== 1) return { status: "skip" };
    if (this.config.vat_included !== 1) return { status: "skip" };
    if (!this.viesChecker) return { status: "skip" };

    const order = normalized.order;
    const company = (order.billing_address?.company ?? "").trim();
    if (!company) return { status: "skip" };

    const buyerCC = String(order.billing_address?.country_code ?? "").trim().toUpperCase();
    if (!isCrossBorderEU(buyerCC)) return { status: "skip" };

    const candidates = this.extractEuVatCandidates(normalized);
    if (candidates.length === 0) return { status: "skip" };

    let lastDeferred: { countryCode: string; vatNumber: string } | null = null;
    for (const c of candidates) {
      const res = await this.viesChecker(c.countryCode, c.vatNumber);
      if (res === true) return { status: "apply", countryCode: c.countryCode, vatNumber: c.vatNumber };
      if (res === null) lastDeferred = c;
    }
    if (lastDeferred) return { status: "deferred", ...lastDeferred };
    return { status: "skip" };
  }

  buildReverseChargeInvoice(normalized: Normalized, countryCode: string, vatNumber: string): { invoice: IxInvoice; requestTaxExemptionReason: true } {
    const client = this.buildInvoiceClient(normalized);
    // Build the (zero-tax) lines from the SAME source the normal create path
    // uses. Under NORMALIZE_IN_WORKER the in-worker normalizer leaves the
    // computed `order.items` empty (the raw builder recomputes from raw_order),
    // so reading `order.items` here yields an EMPTY reverse-charge invoice that
    // IX rejects → the B2B EU order never invoices. Prefer the raw builder when
    // raw_order is present so items are always populated; fall back to the
    // computed items only when there is no raw order (e.g. a stored pending row).
    const items = normalized.raw_order
      ? this.buildInvoiceItemsFromRaw(normalized.raw_order, { forceZeroTax: true })
      : this.buildInvoiceItems(normalized.order.items, { forceZeroTax: true });
    if (items.length === 0) {
      throw new Error(`Reverse-charge invoice for Order #${normalized.order.order_number} has no line items — refusing to POST an empty document`);
    }
    const reasonCode = this.config.ix_b2b_exemption_reason ?? "M16";
    const rcMention = `Reverse charge — Article 196 EU VAT Directive 2006/112/EC. Buyer VAT: ${countryCode}${vatNumber}`;
    const noteRaw = (normalized.order.note ?? "").trim();
    const observations = (noteRaw ? `${noteRaw} | ${rcMention}` : rcMention).slice(0, 200);

    const invoice: IxInvoice = {
      client,
      items,
      reference: documentReference(normalized.order),
      observations,
      date: normalized.order.created_at,
      due_date: normalized.order.created_at,
      tax_exemption_reason: reasonCode,
      ...normalized.order?.global_discount
        ? {
          global_discount: {
            value: normalized.order.global_discount.percent,
            value_type: "percentage",
          },
        } : {},
    };
    return { invoice, requestTaxExemptionReason: true };
  }

  // Async variant: runs the 7-signal gate first. Returns "deferred" when VIES
  // is unreachable so the caller can enqueue a pending row instead of creating
  // an invoice. For "skip" or "apply" returns a ready invoice payload.
  async createInvoiceFromNormalizedOrderAsync(normalized: Normalized): Promise<AsyncInvoiceBuild> {
    const decision = await this.resolveReverseCharge(normalized);
    if (decision.status === "deferred") {
      return { status: "deferred", countryCode: decision.countryCode, vatNumber: decision.vatNumber };
    }
    if (decision.status === "apply") {
      // No nifHold here on purpose: VIES confirmed a real intra-EU VAT number,
      // so whatever else the buyer typed into an address line is irrelevant to
      // the document's fiscal identity.
      const { invoice, requestTaxExemptionReason } = this.buildReverseChargeInvoice(normalized, decision.countryCode, decision.vatNumber);
      return { status: "ready", invoice, requestTaxExemptionReason, reverseCharge: true };
    }
    const { invoice, requestTaxExemptionReason, nifHold } = this.createInvoiceFromNormalizedOrder(normalized);
    return { status: "ready", invoice, requestTaxExemptionReason, reverseCharge: false, nifHold };
  }
}
