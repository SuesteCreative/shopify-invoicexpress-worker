import type { SourceAdapter, AdapterCtx } from "../types";
import type { Normalized } from "../../api/normalize-shopify";

/**
 * Verifies a Stripe webhook signature per
 * https://stripe.com/docs/webhooks#verify-manually.
 *
 * Header format: "t=<unix>,v1=<hex_sig>[,v0=...]"
 * Signed payload: `${t}.${rawBody}`
 * MAC: HMAC-SHA256(signed_payload, webhook_secret), hex-encoded.
 *
 * Returns true iff at least one v1 signature matches and the timestamp is
 * within `toleranceSeconds` of now (default 5 minutes, matches official SDK).
 */
async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  const parts = signatureHeader.split(",").map(p => p.trim());
  const timestamp = parts.find(p => p.startsWith("t="))?.slice(2);
  const v1Sigs = parts.filter(p => p.startsWith("v1=")).map(p => p.slice(3));
  if (!timestamp || v1Sigs.length === 0) return false;

  const ageSec = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (Number.isNaN(ageSec) || ageSec > toleranceSeconds) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const macBuf = await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${rawBody}`));
  const macHex = Array.from(new Uint8Array(macBuf)).map(b => b.toString(16).padStart(2, "0")).join("");

  return v1Sigs.some(sig => timingSafeEqual(sig, macHex));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Maps a Stripe event payload into the canonical `Normalized` shape used by
 * IxBuilder. Phase 3 ships this minimum viable mapping; we'll extend per-event
 * (invoice.paid, charge.succeeded, charge.refunded) when wiring the first real
 * Stripe-source connection.
 */
function metadataToNoteAttributes(metadata: any): any[] {
  if (!metadata || typeof metadata !== "object") return [];
  return Object.entries(metadata).map(([name, value]) => ({ name, value: String(value ?? "") }));
}

/**
 * Stripe Checkout Session `custom_fields[]` shape:
 *   { key, label: {type, custom}, type: "text"|"dropdown"|"numeric",
 *     text?: {value}, dropdown?: {value}, numeric?: {value} }
 * Merchants name the NIF/VAT field freely (NIF, VAT, Contribuinte, etc.), so
 * we push the field as a note_attribute with `name = key + label` and the value
 * concatenated. The downstream PT NIF extractor fuzzy-matches keywords on the
 * name, so anything containing nif/vat/fiscal/contribuinte/iva/tva is caught.
 */
function customFieldsToNoteAttributes(customFields: any): any[] {
  if (!Array.isArray(customFields)) return [];
  const out: any[] = [];
  for (const field of customFields) {
    if (!field || typeof field !== "object") continue;
    const key = String(field.key ?? "");
    const labelText = field.label?.type === "custom" ? String(field.label?.custom ?? "") : "";
    const value =
      field.text?.value ??
      field.dropdown?.value ??
      field.numeric?.value ??
      "";
    if (value === "") continue;
    out.push({ name: `${key} ${labelText}`.trim() || "custom_field", value: String(value) });
  }
  return out;
}

/**
 * Stripe `tax_ids[]` shape (both on Customer object and Checkout Session's
 * customer_details): { type: "pt_nif"|"eu_vat"|..., value: "PT123456789" }.
 * Mapped to note_attributes with name="VAT" so the extractor's "vat" keyword
 * picks them up. EU-prefixed values feed extractEuVatCandidates for the
 * reverse-charge gate.
 */
function taxIdsToNoteAttributes(taxIds: any): any[] {
  if (!Array.isArray(taxIds)) return [];
  const out: any[] = [];
  for (const tid of taxIds) {
    if (!tid || typeof tid !== "object") continue;
    const value = String(tid.value ?? "");
    if (!value) continue;
    const type = String(tid.type ?? "vat");
    out.push({ name: `vat (${type})`, value });
  }
  return out;
}

/**
 * Pull tax_ids off a Stripe Customer ID via the REST API. Used when the event
 * is a PaymentIntent or Charge that didn't go through Checkout — Session
 * events carry tax_ids inline and don't need this call.
 *
 * Failures are swallowed: the worst case is we miss a B2B VAT, but the
 * invoice still gets created for the buyer.
 */
async function fetchCustomerTaxIds(customerId: string, restrictedKey: string): Promise<any[]> {
  try {
    const url = `https://api.stripe.com/v1/customers/${encodeURIComponent(customerId)}?expand[]=tax_ids`;
    const res = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${restrictedKey}`,
        "Stripe-Version": "2024-12-18.acacia",
      },
    });
    if (!res.ok) {
      console.warn(`[Stripe] Customer expand failed (${res.status}) for ${customerId}`);
      return [];
    }
    const body: any = await res.json();
    return Array.isArray(body?.tax_ids?.data) ? body.tax_ids.data : [];
  } catch (e: any) {
    console.warn(`[Stripe] Customer expand network error for ${customerId}: ${e?.message ?? e}`);
    return [];
  }
}

/**
 * Map Stripe's billing_details (or shipping) into our address shape AND
 * surface the company field so the PT NIF extractor can scan it.
 */
function addrFromStripeBilling(addr: any, name?: string, phone?: string, company?: string) {
  const base = addrFromStripe(addr, name, phone);
  return { ...base, company: company ?? null };
}

/**
 * Stable 32-bit hash of an identity string used as the IX client `code`.
 * IX deduplicates clients by `code` — if two invoices share a code, the
 * second invoice reuses (and does NOT update) the existing client. So we
 * must pick a code that is unique per Stripe customer (or per transaction
 * if no customer attached).
 */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function stableCustomerId(...candidates: Array<string | null | undefined>): number {
  const ident = candidates.find(c => typeof c === "string" && c.length > 0);
  return ident ? fnv1a32(ident as string) : 0;
}

export function stripeToNormalized(event: any): Normalized | null {
  const obj = event?.data?.object;
  if (!obj) return null;

  // Four shapes we handle today: Checkout Session (preferred trigger when the
  // buyer used Stripe Checkout because the payload carries custom_fields +
  // customer_details.tax_ids inline), PaymentIntent, Charge, and Invoice.
  const isCheckoutSession = event.type === "checkout.session.completed";
  const isPaymentIntent = event.type?.startsWith("payment_intent.");
  const isInvoice = event.type?.startsWith("invoice.");
  const isCharge = event.type?.startsWith("charge.");

  if (!isInvoice && !isCharge && !isPaymentIntent && !isCheckoutSession) return null;

  if (isCheckoutSession) {
    const session = obj;
    // Only emit invoices for paid sessions. Free/zero-amount sessions
    // (`no_payment_required`) and unpaid drafts are skipped.
    if (session.payment_status && session.payment_status !== "paid") return null;

    const amount = (session.amount_total ?? 0) / 100;
    // VAT from Stripe Tax (Checkout). When Stripe collected tax, invoice the NET
    // unit price + the rate derived from Stripe's own amount_tax, so Moloni
    // reproduces the exact gross the buyer paid (the reconcile guard enforces it).
    // When Stripe collected no tax, leave the line untaxed so the downstream
    // default VAT rate / exemption applies.
    const sessionTax = (session.total_details?.amount_tax ?? 0) / 100;
    const sessionNet = session.amount_subtotal != null ? session.amount_subtotal / 100 : amount - sessionTax;
    const sessionRate = sessionTax > 0 && sessionNet > 0 ? Math.round((sessionTax / sessionNet) * 10000) / 100 : 0;
    const sessionUnit = sessionRate > 0 ? sessionNet : amount;
    const details = session.customer_details ?? {};
    const billingName = details.name ?? session.shipping_details?.name ?? "";
    const billingEmail = details.email ?? session.customer_email ?? "";
    const billingPhone = details.phone ?? "";
    const billingCompany = details.tax_exempt ? null : null; // Stripe doesn't surface company on customer_details; use Customer expand when needed.
    const description = session.description || details.name || `Stripe checkout ${session.id}`;
    // Dedup key: prefer the linked PI so this event and payment_intent.succeeded
    // hash to the same processed_orders row.
    const stableRef = session.payment_intent || session.id;
    const customerStableId = stableCustomerId(session.customer, billingEmail, stableRef);

    // Note attributes accumulate metadata + custom_fields + collected tax_ids.
    const noteAttrs = [
      ...metadataToNoteAttributes(session.metadata),
      ...customFieldsToNoteAttributes(session.custom_fields),
      ...taxIdsToNoteAttributes(details.tax_ids),
    ];

    return {
      order: {
        id: customerStableId,
        reference: String(stableRef),
        order_number: 0,
        created_at: new Date((session.created ?? Date.now() / 1000) * 1000).toISOString(),
        note: session.description ?? null,
        note_attributes: noteAttrs,
        metafields: null,
        tags: [],
        meta: {
          device_id: null,
          token: session.id,
          source_name: "stripe",
          browser_ip: "",
          payment_gateway_names: ["stripe"],
          source_identifier: session.payment_intent ?? session.id,
          confirmation_number: session.payment_intent ?? session.id,
          processed_at: new Date((session.created ?? Date.now() / 1000) * 1000).toISOString(),
        },
        total: amount,
        total_calculated: amount,
        currency: (session.currency ?? "eur").toUpperCase(),
        shop_currency: (session.currency ?? "eur").toUpperCase(),
        exchange_rate: 1,
        financial_status: "paid",
        fulfillment_status: null,
        customer: {
          id: customerStableId,
          email: billingEmail,
          name: billingName,
          created_at: new Date().toISOString(),
          default_address: emptyAddress(),
          address: emptyAddress(),
        },
        billing_address: addrFromStripeBilling(details.address, billingName, billingPhone, billingCompany ?? undefined),
        shipping_address: addrFromStripeBilling(session.shipping_details?.address ?? details.address, session.shipping_details?.name ?? billingName, billingPhone, undefined),
        items: [{
          id: 1,
          product_id: 0,
          variant_id: 0,
          quantity: 1,
          unit_price: sessionUnit,
          unit_price_calculated: sessionUnit,
          subtotal_calculated: sessionUnit,
          tax: { name: "VAT", value: sessionRate, unit_amount: sessionRate > 0 ? sessionTax : 0 },
          discount: { name: "", percent: 0 },
          title: description,
          variant_title: null,
          sku: session.id,
          fulfilled: true,
          fulfilled_quantity: 1,
          fulfillment_status: "fulfilled",
        }],
        global_discount: { name: "", percent: 0, amount: 0 },
      },
      refunds: [],
      exchanges: [],
      credits: [],
      debits: [],
    };
  }

  if (isPaymentIntent) {
    const pi = obj;
    // Only succeeded PaymentIntents become invoices. Defensive — the canonical
    // mapping already filters on event type, but if Stripe ever sends an event
    // with a non-succeeded status we skip rather than emit a draft.
    if (pi.status && pi.status !== "succeeded") return null;

    const amount = (pi.amount_received ?? pi.amount ?? 0) / 100;
    const description = pi.description ?? `Stripe payment ${pi.id}`;
    const billingName = pi.shipping?.name ?? "";
    const customerStableId = stableCustomerId(pi.customer, pi.receipt_email, pi.id);
    return {
      order: {
        id: customerStableId,
        reference: pi.id,
        order_number: 0,
        created_at: new Date((pi.created ?? Date.now() / 1000) * 1000).toISOString(),
        note: pi.description ?? null,
        note_attributes: metadataToNoteAttributes(pi.metadata),
        metafields: null,
        tags: [],
        meta: {
          device_id: null,
          token: pi.id,
          source_name: "stripe",
          browser_ip: "",
          payment_gateway_names: ["stripe"],
          source_identifier: pi.id,
          confirmation_number: pi.id,
          processed_at: new Date((pi.created ?? Date.now() / 1000) * 1000).toISOString(),
        },
        total: amount,
        total_calculated: amount,
        currency: (pi.currency ?? "eur").toUpperCase(),
        shop_currency: (pi.currency ?? "eur").toUpperCase(),
        exchange_rate: 1,
        financial_status: "paid",
        fulfillment_status: null,
        customer: {
          id: customerStableId,
          email: pi.receipt_email ?? "",
          name: billingName,
          created_at: new Date().toISOString(),
          default_address: emptyAddress(),
          address: emptyAddress(),
        },
        billing_address: addrFromStripe(pi.shipping?.address, billingName, pi.shipping?.phone),
        shipping_address: addrFromStripe(pi.shipping?.address, billingName, pi.shipping?.phone),
        items: [{
          id: 1,
          product_id: 0,
          variant_id: 0,
          quantity: 1,
          unit_price: amount,
          unit_price_calculated: amount,
          subtotal_calculated: amount,
          tax: { name: "VAT", value: 0, unit_amount: 0 },
          discount: { name: "", percent: 0 },
          title: description,
          variant_title: null,
          sku: pi.id,
          fulfilled: true,
          fulfilled_quantity: 1,
          fulfillment_status: "fulfilled",
        }],
        global_discount: { name: "", percent: 0, amount: 0 },
      },
      refunds: [],
      exchanges: [],
      credits: [],
      debits: [],
    };
  }

  if (isInvoice) {
    const inv = obj;
    const lines: any[] = inv.lines?.data ?? [];
    return {
      order: {
        id: Number((inv.number || inv.id).toString().replace(/\D/g, "").slice(-12)) || 0,
        reference: inv.id,
        order_number: Number((inv.number || "0").toString().replace(/\D/g, "")) || 0,
        created_at: new Date((inv.created ?? Date.now() / 1000) * 1000).toISOString(),
        note: inv.description ?? null,
        note_attributes: [],
        metafields: null,
        tags: [],
        meta: {
          device_id: null,
          token: inv.id,
          source_name: "stripe",
          browser_ip: "",
          payment_gateway_names: ["stripe"],
          source_identifier: null,
          confirmation_number: inv.id,
          processed_at: new Date((inv.status_transitions?.paid_at ?? inv.created ?? Date.now() / 1000) * 1000).toISOString(),
        },
        total: (inv.amount_paid ?? inv.total ?? 0) / 100,
        total_calculated: (inv.amount_paid ?? inv.total ?? 0) / 100,
        currency: (inv.currency ?? "eur").toUpperCase(),
        shop_currency: (inv.currency ?? "eur").toUpperCase(),
        exchange_rate: 1,
        financial_status: inv.status === "paid" ? "paid" : (inv.status ?? "pending"),
        fulfillment_status: null,
        customer: {
          id: 0,
          email: inv.customer_email ?? "",
          name: inv.customer_name ?? "",
          created_at: new Date().toISOString(),
          default_address: emptyAddress(),
          address: emptyAddress(),
        },
        billing_address: addrFromStripe(inv.customer_address, inv.customer_name, inv.customer_phone),
        shipping_address: addrFromStripe(inv.customer_shipping?.address, inv.customer_shipping?.name, inv.customer_shipping?.phone),
        items: lines.map((l, idx) => {
          // Stripe invoice lines carry the net `amount` + `tax_amounts[]`; derive
          // the per-line rate so mixed-rate invoices map correctly. No tax → 0.
          const lineNet = (l.amount ?? 0) / 100;
          const lineTax = Array.isArray(l.tax_amounts) ? l.tax_amounts.reduce((s: number, t: any) => s + (t?.amount ?? 0), 0) / 100 : 0;
          const lineRate = lineTax > 0 && lineNet > 0 ? Math.round((lineTax / lineNet) * 10000) / 100 : 0;
          const qty = l.quantity || 1;
          return {
            id: idx + 1,
            product_id: 0,
            variant_id: 0,
            quantity: l.quantity ?? 1,
            unit_price: lineNet / qty,
            unit_price_calculated: lineNet / qty,
            subtotal_calculated: lineNet,
            tax: { name: "VAT", value: lineRate, unit_amount: lineTax },
            discount: { name: "", percent: 0 },
            title: l.description ?? "Item",
            variant_title: null,
            sku: l.price?.id ?? "",
            fulfilled: true,
            fulfilled_quantity: l.quantity ?? 1,
            fulfillment_status: "fulfilled",
          };
        }),
        global_discount: { name: "", percent: 0, amount: 0 },
      },
      refunds: [],
      exchanges: [],
      credits: [],
      debits: [],
    };
  }

  // Charge shape (no lines — single item)
  const ch = obj;
  const chCustomerStableId = stableCustomerId(ch.customer, ch.billing_details?.email, ch.receipt_email, ch.payment_intent, ch.id);
  return {
    order: {
      id: chCustomerStableId,
      reference: ch.id,
      order_number: 0,
      created_at: new Date((ch.created ?? Date.now() / 1000) * 1000).toISOString(),
      note: ch.description ?? null,
      note_attributes: [],
      metafields: null,
      tags: [],
      meta: {
        device_id: null,
        token: ch.id,
        source_name: "stripe",
        browser_ip: "",
        payment_gateway_names: ["stripe"],
        source_identifier: ch.payment_intent ?? null,
        confirmation_number: ch.id,
        processed_at: new Date((ch.created ?? Date.now() / 1000) * 1000).toISOString(),
      },
      total: (ch.amount ?? 0) / 100,
      total_calculated: (ch.amount ?? 0) / 100,
      currency: (ch.currency ?? "eur").toUpperCase(),
      shop_currency: (ch.currency ?? "eur").toUpperCase(),
      exchange_rate: 1,
      financial_status: ch.refunded ? "refunded" : (ch.status === "succeeded" ? "paid" : ch.status ?? "pending"),
      fulfillment_status: null,
      customer: {
        id: chCustomerStableId,
        email: ch.billing_details?.email ?? ch.receipt_email ?? "",
        name: ch.billing_details?.name ?? "",
        created_at: new Date().toISOString(),
        default_address: emptyAddress(),
        address: emptyAddress(),
      },
      billing_address: addrFromStripe(ch.billing_details?.address, ch.billing_details?.name, ch.billing_details?.phone),
      shipping_address: addrFromStripe(ch.shipping?.address, ch.shipping?.name, ch.shipping?.phone),
      items: [{
        id: 1,
        product_id: 0,
        variant_id: 0,
        quantity: 1,
        unit_price: (ch.amount ?? 0) / 100,
        unit_price_calculated: (ch.amount ?? 0) / 100,
        subtotal_calculated: (ch.amount ?? 0) / 100,
        tax: { name: "VAT", value: 0, unit_amount: 0 },
        discount: { name: "", percent: 0 },
        title: ch.description ?? `Stripe charge ${ch.id}`,
        variant_title: null,
        sku: ch.payment_intent ?? "",
        fulfilled: true,
        fulfilled_quantity: 1,
        fulfillment_status: "fulfilled",
      }],
      global_discount: { name: "", percent: 0, amount: 0 },
    },
    refunds: [],
    exchanges: [],
    credits: ch.refunded ? [{
      refund_id: ch.refunds?.data?.[0]?.id ?? ch.id,
      amount: (ch.amount_refunded ?? 0) / 100,
      line_items: [{ id: 1, quantity: 1, subtotal: (ch.amount_refunded ?? 0) / 100, total_tax: 0 }],
    }] : [],
    debits: [],
  };
}

function emptyAddress() {
  return {
    first_name: "", last_name: "", name: "", company: null,
    address1: "", address2: "", city: "", province: "", province_code: "",
    zip: "", country: "", country_code: "", phone: null,
  };
}

function addrFromStripe(addr: any, name?: string, phone?: string) {
  const base = emptyAddress();
  if (!addr) return { ...base, name: name ?? "", phone: phone ?? null };
  return {
    ...base,
    first_name: name?.split(" ")[0] ?? "",
    last_name: name?.split(" ").slice(1).join(" ") ?? "",
    name: name ?? "",
    address1: addr.line1 ?? "",
    address2: addr.line2 ?? "",
    city: addr.city ?? "",
    province: addr.state ?? "",
    province_code: addr.state ?? "",
    zip: addr.postal_code ?? "",
    country: addr.country ?? "",
    country_code: addr.country ?? "",
    phone: phone ?? null,
  };
}

export class StripeSource implements SourceAdapter {
  readonly kind = "stripe" as const;

  async verifyWebhook(rawBody: string, signature: string, secret: string): Promise<boolean> {
    return verifyStripeSignature(rawBody, signature, secret);
  }

  externalId(parsedBody: any): string {
    const event = parsedBody;
    const obj = event?.data?.object;
    if (!obj) return String(event?.id ?? "");

    // Charge events reference their originating PaymentIntent so they dedup with
    // payment_intent.succeeded. A single card payment fires BOTH charge.succeeded
    // AND payment_intent.succeeded — without this they'd get different ids and
    // Rioko would create TWO invoices for one payment. Refund credit notes
    // likewise attach to the invoice created for the PI.
    if ((event.type === "charge.succeeded" || event.type === "charge.refunded") && obj.payment_intent) {
      return String(obj.payment_intent);
    }
    // Checkout Session and its PaymentIntent both produce a webhook for the
    // same purchase. Hash both to the same id (the PI) so processed_orders
    // dedup makes whichever event arrived second a no-op.
    if (event.type === "checkout.session.completed" && obj.payment_intent) {
      return String(obj.payment_intent);
    }
    return String(obj.id ?? "");
  }

  async toNormalized(parsedBody: any, ctx: AdapterCtx): Promise<Normalized | null> {
    const normalized = stripeToNormalized(parsedBody);
    if (!normalized) return null;

    // Customer.tax_ids enrichment: for PI/Charge events the Customer's tax_ids
    // aren't on the event payload, so we expand via Stripe API when we have
    // a restricted_key in source_config. Session events already include
    // customer_details.tax_ids in the payload, so we skip the call there.
    const event = parsedBody;
    const obj = event?.data?.object;
    const isSession = event?.type === "checkout.session.completed";
    const restrictedKey = ctx.sourceConfig?.restricted_key as string | undefined;

    if (!isSession && restrictedKey && obj?.customer && typeof obj.customer === "string") {
      const taxIds = await fetchCustomerTaxIds(obj.customer, restrictedKey);
      if (taxIds.length > 0) {
        const extra = taxIdsToNoteAttributes(taxIds);
        normalized.order.note_attributes = [
          ...(normalized.order.note_attributes ?? []),
          ...extra,
        ];
      }
    }

    return normalized;
  }
}
