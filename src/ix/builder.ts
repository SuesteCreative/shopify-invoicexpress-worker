import type { IRequestConfig } from "../storage";
import type { Normalized } from "../api/normalize-shopify";
import type { PostV2CreditNotesData, PostV2InvoicesData } from "../api/ix/client";
import { validatePTNIF } from "./nif";
import { isCrossBorderEU } from "./eu-countries";
import type { ViesChecker } from "./vies";
import { format } from "date-fns";

export type IxInvoice = NonNullable<PostV2InvoicesData["body"]>["invoice"];
export type IxCreditNote = NonNullable<PostV2CreditNotesData["body"]>["credit_note"];

export type ReverseChargeDecision =
  | { status: "apply"; countryCode: string; vatNumber: string }
  | { status: "skip" }
  | { status: "deferred"; countryCode: string; vatNumber: string };

export type AsyncInvoiceBuild =
  | { status: "ready"; invoice: IxInvoice; requestTaxExemptionReason: boolean; reverseCharge: boolean }
  | { status: "deferred"; countryCode: string; vatNumber: string };

export class IxBuilder {
  private readonly config: IRequestConfig;
  private readonly viesChecker?: ViesChecker;

  constructor(config: IRequestConfig, viesChecker?: ViesChecker) {
    this.config = config;
    this.viesChecker = viesChecker;
  }

  shouldRequestTaxExemptionReason(items: IxInvoice["items"]) {
    return items.some(item =>
      (typeof item.tax === "number"
        ? item.tax
        : item.tax.value) === 0
    );
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
      return {
        quantity: item.quantity,
        tax,
        unit_price: item.unit_price,
        discount: item?.discount?.percent ?? undefined,
        name,
        ...(description ? { description } : {}),
      };
    });
  }

  pickInvoiceAddress(normalized: Normalized) {
    const customer = normalized.order.customer;

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

  createInvoiceFromNormalizedOrder(normalized: Normalized) {
    const client = this.buildInvoiceClient(normalized);
    const items = this.buildInvoiceItems(normalized.order.items);
    const requestTaxExemptionReason = this.shouldRequestTaxExemptionReason(items);

    const invoice: IxInvoice = {
      client,
      items,
      reference: `Order #${normalized.order.order_number}`,
      ...normalized.order?.note ? {
        observations: (normalized.order.note ?? "").slice(0, 200),
      } : {},
      date: normalized.order.created_at,
      due_date: normalized.order.created_at,
      tax_exemption_reason: requestTaxExemptionReason ? this.config.ix_exemption_reason ?? undefined : undefined,
      ...this.config.ix_retention_enabled === 1
        && typeof this.config.ix_retention === "number"
        && this.config.ix_retention > 0
        ? { retention: this.config.ix_retention.toFixed(2) }
        : {},
      ...normalized.order?.global_discount
        ? {
          global_discount: {
            value: normalized.order.global_discount.percent,
            value_type: "percentage"
          }
        } : {}
    }

    return { invoice, requestTaxExemptionReason };
  }

  buildInvoiceClient(normalized: Normalized): IxInvoice["client"] {
    const nif = this.extractAndValidateNIF(normalized);
    const order = normalized.order;

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

    const rawCountry = String(order.billing_address?.country_code || order.billing_address?.country || "").trim();

    return {
      name,
      email,
      fiscal_id: nif ?? undefined,
      code: String(order.customer?.id || order.id),
      address: address.address1,
      city: order.billing_address?.city,
      country: rawCountry,
      phone: order.customer?.phone || order.billing_address?.phone
    };
  }

  extractAndValidateNIF(normalized: Normalized): string | null {
    const candidates: string[] = [];
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
          if (clean.length >= 9) candidates.push(clean.slice(-9));
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

    // 7. If no algorithm match, pick the first 9-digit candidate if any (for international or just in case)
    if (candidates.length > 0) return candidates[0];

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
