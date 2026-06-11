import type { IRequestConfig } from "../storage";
import type { Normalized } from "../api/normalize-shopify";
import type { PostV2CreditNotesData, PostV2InvoicesData } from "../api/ix/client";
import { validatePTNIF } from "./nif";
import { isCrossBorderEU } from "./eu-countries";
import type { ViesChecker } from "./vies";
import { type ReconcileLine } from "../adapters/reconcile";
import { format } from "date-fns";

export type IxInvoice = NonNullable<PostV2InvoicesData["body"]>["invoice"];
export type IxCreditNote = NonNullable<PostV2CreditNotesData["body"]>["credit_note"];

/**
 * InvoiceXpress requires the client country as a full English name ("Portugal",
 * "Germany"), NOT an ISO code. Sending "PT" fails with `Country PT was not found`
 * (422), which the invoice endpoint surfaces as the cascading "Client is invalid /
 * Fiscal is invalid". Shopify already provides the full name in `billing_address.country`;
 * Stripe-source only has the ISO code, so map any bare 2-letter code to its English name.
 */
function toIxCountryName(value: string): string {
  const v = (value || "").trim();
  if (v.length !== 2) return v; // already a full name (or empty)
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(v.toUpperCase()) || v;
  } catch {
    return v;
  }
}

export type ReverseChargeDecision =
  | { status: "apply"; countryCode: string; vatNumber: string }
  | { status: "skip" }
  | { status: "deferred"; countryCode: string; vatNumber: string };

export type AsyncInvoiceBuild =
  | { status: "ready"; invoice: IxInvoice; requestTaxExemptionReason: boolean; reverseCharge: boolean }
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

  shouldRequestTaxExemptionReason(items: IxInvoice["items"]) {
    return items.some(item =>
      (typeof item.tax === "number"
        ? item.tax
        : item.tax.value) === 0
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
      const discountPercent = forceZeroTax ? 0 : round4(Math.max(0, rawPercent));
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
      const effectiveRate = forceZeroTax
        ? 0
        : (override?.tax_rate != null
          ? Number(override.tax_rate)
          : (forceTaxProducts != null ? forceTaxProducts : shopifyRate));
      const variantTitle = li?.variant_title ? ` / ${li.variant_title}` : "";
      const defaultName = `${li?.title ?? li?.name ?? "Item"}${variantTitle}`.slice(0, 200);
      const name = (override?.name_override ?? defaultName).slice(0, 200);
      const description = li?.sku ? `SKU: ${li.sku}`.slice(0, 200) : undefined;
      const item = buildLine(grossUnit, quantity, grossLineDiscount, effectiveRate, effectiveRate, name, description, lineIncluded);
      if (item) items.push(item);
    }

    const shippingLines = Array.isArray(rawOrder?.shipping_lines) ? rawOrder.shipping_lines : [];
    for (const sl of shippingLines) {
      // Same effective-rate rule as product lines: trust collected tax, not
      // declared rate. Reverse-charge shipping reports rate but price=0.
      const shipTaxLines = Array.isArray(sl?.tax_lines) ? sl.tax_lines : [];
      const shipTaxCollected = shipTaxLines.reduce((acc: number, t: any) => acc + Number(t?.price ?? 0), 0);
      const shipCollectedRate = shipTaxCollected > 0 ? Number(shipTaxLines[0]?.rate ?? 0) * 100 : 0;
      const grossUnit = Number(sl?.price ?? 0);
      const allocations = Array.isArray(sl?.discount_allocations) ? sl.discount_allocations : [];
      const grossLineDiscount = allocations.reduce((acc: number, a: any) => acc + Number(a?.amount ?? 0), 0);
      // Same effective-rate consistency as product lines: the rate used for the
      // VAT-inclusion math must equal the rate stamped on the line, else the
      // reconcile guard trips. force_shipping_tax_rate > collected shipping rate.
      const shipEffectiveRate = forceZeroTax ? 0 : (forceTaxShipping != null ? forceTaxShipping : shipCollectedRate);
      const name = `Portes de envio${sl?.title ? ` — ${sl.title}` : ""}`.slice(0, 200);
      // Shipping overrides keyed by RIOKO-SHIPPING — same semantics
      const shipOverride = this.overrides?.get("RIOKO-SHIPPING");
      const shipIncluded = shipOverride?.vat_inclusion === "inc"
        ? true
        : shipOverride?.vat_inclusion === "exc"
          ? false
          : undefined;

      // F-SHIP: mixed-rate shipping. On an OSS basket with items at >1 VAT rate,
      // Shopify splits the shipping tax across those rates (e.g. a 12€ CTT line
      // with tax_lines [21%:1.57, 10%:0.45]). The single-rate path above would
      // stamp the WHOLE shipping at tax_lines[0].rate and over/under-tax it
      // (#4172: +0.50€). When the collected shipping tax spans >1 distinct rate
      // (and we're not forcing a rate or zero), emit one sub-line per rate, each
      // sized from that rate's own tax basis, so each portion is taxed correctly.
      const nonzeroShipTax = shipTaxLines.filter((t: any) => Number(t?.price ?? 0) > 0);
      const distinctShipRates = new Set(nonzeroShipTax.map((t: any) => Number(t?.rate ?? 0)));
      const effectiveShipIncluded = shipIncluded ?? shopifyIncluded;
      if (!forceZeroTax && forceTaxShipping == null && grossLineDiscount === 0 && distinctShipRates.size > 1) {
        for (const tl of nonzeroShipTax) {
          const rate = Number(tl?.rate ?? 0) * 100;
          const taxAmt = Number(tl?.price ?? 0);
          if (rate <= 0 || taxAmt <= 0) continue;
          const basisNet = taxAmt / (rate / 100);                                  // pre-tax portion for this rate
          const portionGross = effectiveShipIncluded ? basisNet + taxAmt : basisNet; // buildLine wants gross when included, net when not
          const subName = `${name} (${rate % 1 === 0 ? rate : rate.toFixed(2)}%)`.slice(0, 200);
          const item = buildLine(portionGross, 1, 0, rate, rate, subName, undefined, effectiveShipIncluded);
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

  createInvoiceFromNormalizedOrder(normalized: Normalized) {
    const client = this.buildInvoiceClient(normalized);
    const usingRawPath = !!normalized.raw_order;
    const items = usingRawPath
      ? this.buildInvoiceItemsFromRaw(normalized.raw_order)
      : this.buildInvoiceItems(normalized.order.items);
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
    const rcReason = shopifyReverseCharge
      ? (this.config.ix_b2b_exemption_reason ?? "M16")
      : baseReason;
    const noteRaw = (normalized.order?.note ?? "").trim();
    const rcMention = shopifyReverseCharge ? "IVA - autoliquidação (Art. 196.º Directiva IVA UE)" : "";
    const obsCombined = [noteRaw, rcMention].filter(Boolean).join(" | ").slice(0, 200);

    const invoice: IxInvoice = {
      client,
      items,
      reference: `Order #${normalized.order.order_number}`,
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

    return { invoice, requestTaxExemptionReason };
  }

  buildInvoiceClient(normalized: Normalized): IxInvoice["client"] {
    let nif: string | null = this.extractAndValidateNIF(normalized);
    const order = normalized.order;
    // Foreign-VAT fallback: when no PT NIF found, try the EU-prefixed
    // candidates from the same fields (billing_address.company,
    // note_attributes, note). Picks the candidate matching the buyer's
    // billing country first, then any other. Essential for B2B intra-EU
    // (reverse charge) where IX needs a fiscal_id stamped to honour M16.
    if (!nif) {
      const buyerCC = String(order.billing_address?.country_code ?? "").trim().toUpperCase();
      const euCandidates = this.extractEuVatCandidates(normalized);
      const preferred = euCandidates.find(c => c.countryCode === buyerCC) ?? euCandidates[0];
      if (preferred) nif = `${preferred.countryCode}${preferred.vatNumber}`;
    }

    const customerName = (order.customer?.name || "").trim();
    const billingName = (order.billing_address?.name || "").trim();
    const email = (order.customer?.email || "").trim();
    const address = this.pickInvoiceAddress(normalized);

    const resolvedName = customerName || billingName;
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

    return {
      name,
      email,
      fiscal_id: nif ?? undefined,
      code: String(order.customer?.id || order.id),
      address: address.address1,
      city: order.billing_address?.city,
      country: toIxCountryName(rawCountry),
      phone: order.customer?.phone || order.billing_address?.phone
    };
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

    // 5. Extract from Billing Address fields (Company, Address2)
    const billing = order.billing_address;
    if (billing) {
      if (billing.company) {
        const matches = billing.company.match(/\b\d{9}\b/g);
        if (matches) candidates.push(...matches);
      }
      if (billing.address2) {
        const matches = billing.address2.match(/\b\d{9}\b/g);
        if (matches) candidates.push(...matches);
      }
    }

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

  // Pulls EU VAT candidates (country-code prefixed) from the same fields the
  // NIF extractor reads. Used by the reverse-charge gate so non-PT EU VATs
  // like "ESB12345678" or "DE123456789" are picked up — the PT extractor only
  // captures 9-digit strings, so it would miss letter-prefixed formats.
  extractEuVatCandidates(normalized: Normalized): Array<{ countryCode: string; vatNumber: string }> {
    const out: Array<{ countryCode: string; vatNumber: string }> = [];
    const seen = new Set<string>();
    const push = (cc: string, num: string) => {
      const ccU = cc.toUpperCase();
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

    // Broad EU-prefix regex. Final shape validated by VIES.
    const VAT_RE = /\b([A-Z]{2})([A-Z0-9]{2,12})\b/g;
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
    const items = this.buildInvoiceItems(normalized.order.items, { forceZeroTax: true });
    const reasonCode = this.config.ix_b2b_exemption_reason ?? "M16";
    const rcMention = `Reverse charge — Article 196 EU VAT Directive 2006/112/EC. Buyer VAT: ${countryCode}${vatNumber}`;
    const noteRaw = (normalized.order.note ?? "").trim();
    const observations = (noteRaw ? `${noteRaw} | ${rcMention}` : rcMention).slice(0, 200);

    const invoice: IxInvoice = {
      client,
      items,
      reference: `Order #${normalized.order.order_number}`,
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
      const { invoice, requestTaxExemptionReason } = this.buildReverseChargeInvoice(normalized, decision.countryCode, decision.vatNumber);
      return { status: "ready", invoice, requestTaxExemptionReason, reverseCharge: true };
    }
    const { invoice, requestTaxExemptionReason } = this.createInvoiceFromNormalizedOrder(normalized);
    return { status: "ready", invoice, requestTaxExemptionReason, reverseCharge: false };
  }
}
