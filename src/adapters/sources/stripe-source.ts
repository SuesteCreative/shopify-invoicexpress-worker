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

  // Three main shapes: PaymentIntent (Kapta's primary path), Charge, and Invoice.
  const isPaymentIntent = event.type?.startsWith("payment_intent.");
  const isInvoice = event.type?.startsWith("invoice.");
  const isCharge = event.type?.startsWith("charge.");

  if (!isInvoice && !isCharge && !isPaymentIntent) return null;

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
        items: lines.map((l, idx) => ({
          id: idx + 1,
          product_id: 0,
          variant_id: 0,
          quantity: l.quantity ?? 1,
          unit_price: (l.amount ?? 0) / 100 / (l.quantity || 1),
          unit_price_calculated: (l.amount ?? 0) / 100 / (l.quantity || 1),
          subtotal_calculated: (l.amount ?? 0) / 100,
          tax: { name: "VAT", value: 0, unit_amount: 0 },
          discount: { name: "", percent: 0 },
          title: l.description ?? "Item",
          variant_title: null,
          sku: l.price?.id ?? "",
          fulfilled: true,
          fulfilled_quantity: l.quantity ?? 1,
          fulfillment_status: "fulfilled",
        })),
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

    // Refunds must reference the originating PaymentIntent so the credit note
    // attaches to the invoice we created when the PI succeeded. Stripe puts
    // the link on the Charge as `payment_intent`.
    if (event.type === "charge.refunded" && obj.payment_intent) {
      return String(obj.payment_intent);
    }
    return String(obj.id ?? "");
  }

  async toNormalized(parsedBody: any, _ctx: AdapterCtx): Promise<Normalized | null> {
    return stripeToNormalized(parsedBody);
  }
}
