import type { IRequestConfig } from "../storage";
import type { Normalized } from "../api/normalize-shopify";
import type { PostV2CreditNotesData, PostV2InvoicesData } from "../api/ix/client";
import { validatePTNIF } from "./nif";
import { format } from "date-fns";

export type IxInvoice = NonNullable<PostV2InvoicesData["body"]>["invoice"];
export type IxCreditNote = NonNullable<PostV2CreditNotesData["body"]>["credit_note"];

export class IxBuilder {
  private readonly config: IRequestConfig;

  constructor(config: IRequestConfig) {
    this.config = config;
  }

  shouldRequestTaxExemptionReason(items: IxInvoice["items"]) {
    return items.some(item =>
      (typeof item.tax === "number"
        ? item.tax
        : item.tax.value) === 0
    );
  }

  buildInvoiceItems(normalizedItems: Normalized["order"]["items"]): IxInvoice["items"] {
    return normalizedItems.map(item => ({
      quantity: item.quantity,
      // TODO: Ruben has to fix it
      tax: item.tax.unit_amount === 0 ? 0 : item.tax.value,
      unit_price: item.unit_price,
      discount: item?.discount?.percent ?? undefined,
      name: item.variant_title ? `${item.title} / ${item.variant_title}`.slice(0, 200) : item.title.slice(0, 200),
      description: `Shopify product: ${item.product_id}; variant: ${item.variant_id}`.slice(0, 200)
    }));
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
        name = `Consumidor Final ${format(new Date(), "dd/MM/yyyy HH:mm:ss")}`;
      }
    } else {
      // Standard mode: Use real name if available.
      // Special case: if no NIF is provided, and the name is generic/missing, use "Consumidor Final"
      const isGeneric = !resolvedName || ["client", "unknown"].includes(resolvedName.toLowerCase());
      if (!nif && isGeneric) {
        name = `Consumidor Final ${format(new Date(), "dd/MM/yyyy HH:mm:ss")}`;
      } else {
        name = resolvedName || `Consumidor Final ${format(new Date(), "dd/MM/yyyy HH:mm:ss")}`;
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
    if (order.note_attributes) {
      for (const attr of order.note_attributes) {
        const name = String(attr.name).toLowerCase();
        if (["nif", "vat", "contribuinte", "fiscal", "tax id"].includes(name) && attr.value) {
          const clean = String(attr.value).replace(/\D/g, "");
          if (clean.length >= 9) candidates.push(clean.slice(-9));
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
}
