import type { SourceAdapter, AdapterCtx } from "../types";
import type { Normalized } from "../../api/normalize-shopify";
import { saleReference } from "../../services/document-references";
import { parseMetadataMap, applyMetadataMap, applyMetadataVatRate } from "./metadata-map";
import { pickInvoicePaymentIntent } from "../../services/stripe";

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
 * Pull the buyer's record off a Stripe Customer ID via the REST API — name,
 * email, phone, address AND tax_ids. Used when the event is a PaymentIntent or
 * Charge that didn't go through Checkout — Session events carry
 * customer_details inline and don't need this call.
 *
 * The Customer is where a Stripe buyer's identity actually lives. A PI carries a
 * name only when `shipping` was collected, and `charge.billing_details` is null
 * for the payment methods that don't ask for one (Multibanco, Link, off-session
 * subscription charges). Reading only tax_ids here is what sent a sale to
 * "Consumidor Final" while Stripe held the buyer's full name, PT address and NIF.
 *
 * Failures are swallowed: the worst case is a less complete client record, but
 * the invoice still gets created for the buyer.
 */
async function fetchStripeCustomer(customerId: string, restrictedKey: string): Promise<any | null> {
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
      return null;
    }
    return await res.json();
  } catch (e: any) {
    console.warn(`[Stripe] Customer expand network error for ${customerId}: ${e?.message ?? e}`);
    return null;
  }
}

/**
 * The charge behind a PaymentIntent, which the PI event does not include.
 *
 * Two things live here that the PI cannot answer:
 *  - the buyer's name (`billing_details.name`); a PI carries one only when
 *    `shipping` was collected;
 *  - WHEN THE MONEY ARRIVED (`created`). `pi.created` is when the payment was
 *    *started*. For a card those are the same second, but for Multibanco (and
 *    SEPA debit, Boleto, …) the reference is generated on day one and paid days
 *    later — 12 days apart on pi_3Tz3w0…, which dated the invoice 31/07 for a
 *    payment made on 12/08.
 *
 * Failures are swallowed: the invoice still gets issued, from the PI alone.
 */
async function fetchLatestCharge(paymentIntentId: string, restrictedKey: string): Promise<any | null> {
  try {
    // `latest_charge.balance_transaction` comes along for the ride: it is the
    // only place Stripe states what the payment became in the account's own
    // currency, and at which rate. A foreign-currency sale cannot be invoiced
    // without it (see convertToSettlementCurrency).
    const url = `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}?expand[]=latest_charge.balance_transaction`;
    const res = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${restrictedKey}`,
        "Stripe-Version": "2024-12-18.acacia",
      },
    });
    if (!res.ok) {
      console.warn(`[Stripe] latest_charge expand failed (${res.status}) for ${paymentIntentId}`);
      return null;
    }
    const body: any = await res.json();
    const charge = body?.latest_charge;
    return charge && typeof charge === "object" ? charge : null;
  } catch (e: any) {
    console.warn(`[Stripe] latest_charge expand network error for ${paymentIntentId}: ${e?.message ?? e}`);
    return null;
  }
}

/**
 * The document the VAT actually lives on, for a payment that reached us as a
 * PaymentIntent or a charge.
 *
 * One card payment fires `checkout.session.completed`, `payment_intent.succeeded`
 * and `charge.succeeded`, all three dedup onto the same PaymentIntent, and only
 * the session carries Stripe Tax's numbers — the other two shapes have no VAT
 * breakdown at all and map to a 0% line. So whichever webhook Stripe delivered
 * first decided whether a VAT-charged sale was invoiced with VAT on it.
 *
 * It is not only a race. Every recovery path — backfill, heal, re-emit by
 * `pi_` — synthesizes a PaymentIntent event, so re-issuing a Checkout sale
 * produced a structurally different document from the one it replaced.
 *
 * Returns a synthetic event of the richer shape, ready for `stripeToNormalized`.
 * Failures are swallowed: the caller keeps what it had.
 */
async function fetchRicherTaxSource(
  paymentIntentId: string,
  invoiceId: string | null,
  restrictedKey: string,
  /** Set to `failed: true` when Stripe could not be asked. "No session behind
   *  this payment" and "the lookup errored" look identical in the return value,
   *  and routing hints have to tell them apart: the first says the payment was
   *  created straight through the API, the second says nothing at all. */
  status?: { failed: boolean },
): Promise<any | null> {
  const get = async (url: string): Promise<any | null> => {
    try {
      const res = await fetch(url, {
        headers: {
          "Authorization": `Bearer ${restrictedKey}`,
          "Stripe-Version": "2024-12-18.acacia",
        },
      });
      if (!res.ok) {
        console.warn(`[Stripe] tax-source lookup failed (${res.status}): ${url.split("?")[0]}`);
        if (status) status.failed = true;
        return null;
      }
      return await res.json();
    } catch (e: any) {
      console.warn(`[Stripe] tax-source lookup network error: ${e?.message ?? e}`);
      if (status) status.failed = true;
      return null;
    }
  };

  // A subscription or invoiced payment: the invoice has the lines and their
  // per-line tax, which is richer than anything the session would give us.
  if (invoiceId) {
    const inv = await get(`https://api.stripe.com/v1/invoices/${encodeURIComponent(invoiceId)}`);
    if (inv?.id) return { type: "invoice.paid", data: { object: inv } };
  }

  if (!paymentIntentId) return null;
  const list = await get(
    `https://api.stripe.com/v1/checkout/sessions?payment_intent=${encodeURIComponent(paymentIntentId)}&limit=1`,
  );
  const session = Array.isArray(list?.data) ? list.data[0] : null;
  if (session?.id) return { type: "checkout.session.completed", data: { object: session } };

  return null;
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

/**
 * The one id that identifies a Stripe sale across every event that describes it.
 *
 * A single card payment fires several webhooks (charge.succeeded,
 * payment_intent.succeeded, checkout.session.completed) and each carries a
 * different `obj.id`, so anything that has to be stable per SALE — the
 * processed_orders dedup key AND the document reference — has to collapse them
 * onto the PaymentIntent.
 *
 * `externalId()` and `stripeToNormalized()` both call this precisely so they can
 * never disagree: they did disagree until 2026-08-14, when the dedup key was the
 * PI but the document reference was built from a hardcoded `order_number: 0`.
 */
export function stripeStableId(event: any): string {
  const obj = event?.data?.object;
  if (!obj) return String(event?.id ?? "");

  // Charge and Checkout Session events point back at the PaymentIntent that
  // settled them; the PI is the sale.
  const type = String(event?.type ?? "");
  if ((type === "charge.succeeded" || type === "charge.refunded" || type === "checkout.session.completed") && obj.payment_intent) {
    return String(obj.payment_intent);
  }

  // A Stripe invoice paid by card is the same sale as the PaymentIntent that
  // paid it, and both events describe it. Without this they would be two
  // different sales — `in_…` and `pi_…` — and the merchant would get two
  // documents for one payment.
  //
  // An invoice the merchant marked as paid OUTSIDE Stripe has no PaymentIntent
  // and no charge, because no money moved through Stripe. It keeps its own id,
  // which is right: that invoice is the only record of the sale.
  if (type.startsWith("invoice.")) {
    // One rule, one place. This used to read `payments.data[0]` directly, which
    // is right only while the paid entry happens to be listed first: an invoice
    // settled outside Stripe also carries the PaymentIntent Stripe abandoned,
    // and picking that one files the sale under a payment that never happened.
    const pi = pickInvoicePaymentIntent(obj);
    if (pi) return pi;
  }

  return String(obj.id ?? "");
}

export function stripeToNormalized(event: any): Normalized | null {
  const obj = event?.data?.object;
  if (!obj) return null;

  // The document reference for EVERY Stripe shape. Built from the sale's stable
  // id, never from `order_number` — Stripe payloads have no order number, so the
  // shapes below hardcode 0 and `saleReference(0)` would label every payment in
  // the account "Order #0" (see stripeStableId).
  const invoiceReference = saleReference(stripeStableId(event));

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
    // Net is `amount_total - amount_tax`, NEVER `amount_subtotal`: Stripe strikes
    // the subtotal BEFORE discounts and outside shipping, so on any session
    // carrying a promo code it overstates the net and understates the derived
    // rate - and the reconcile guard then aborts the sale with no invoice at all
    // (subtotal 100, coupon -20, VAT 23% -> paid 98.40 vs expected 118.40).
    // The subtraction holds for inclusive tax too: Stripe reports the tax
    // contained in the total in this same field.
    const sessionNet = round2(amount - sessionTax);
    const sessionRate = sessionTax > 0 && sessionNet > 0 ? Math.round((sessionTax / sessionNet) * 10000) / 100 : 0;
    // Re-derive the unit from the ROUNDED rate instead of shipping sessionNet
    // straight through: the destination recomputes gross as net * (1 + rate/100)
    // and a rate rounded to 2dp drifts past the guard's 1 cent tolerance on
    // bigger sales. Dividing the paid total back out keeps the two in agreement.
    const sessionUnit = sessionRate > 0 ? round2(amount / (1 + sessionRate / 100)) : amount;
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
        invoice_reference: invoiceReference,
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
        invoice_reference: invoiceReference,
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
        // Deliberately the stable id, not `order_number` above: an unnumbered
        // Stripe invoice degrades that to 0 (same trap as the other shapes), and
        // stripping the non-digits out of "INV-0001" yields a bare "1" that can
        // collide with another source feeding the same destination document set.
        invoice_reference: invoiceReference,
        created_at: new Date((inv.created ?? Date.now() / 1000) * 1000).toISOString(),
        note: inv.description ?? null,
        // Same reason as the charge shape: without this, a Stripe Invoice has no
        // routable signal and every tag rule silently misses.
        note_attributes: metadataToNoteAttributes(inv.metadata),
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
          // Stripe invoice lines carry `amount` + `tax_amounts[]` + `discount_amounts[]`,
          // and `amount` is struck BEFORE any discount. A coupon - line-level, or
          // an invoice/subscription-level one Stripe allocates down onto the lines -
          // has to come off here, or the summed lines overshoot `amount_paid` and
          // the reconcile guard aborts with no invoice at all. Derive the per-line
          // rate from the DISCOUNTED net so mixed-rate invoices still map correctly.
          //
          // Two shapes, because Stripe moved these fields. Up to 2024 a line
          // carried `tax_amounts[{ amount, inclusive }]`; from the 2025 versions
          // (measured on 2026-04-22.dahlia) it carries `taxes[{ amount,
          // tax_behavior }]`. Reading only the old one silently invoiced every
          // line at 0% on a current account.
          const taxAmounts = Array.isArray(l.tax_amounts) ? l.tax_amounts
            : Array.isArray(l.taxes) ? l.taxes
            : [];
          const lineTax = sumStripeAmounts(taxAmounts);
          // Inclusive tax sits inside `amount`; exclusive tax sits outside it. Only
          // the inclusive part is subtracted to reach a VAT-exclusive net.
          const inclusiveTax = sumStripeAmounts(
            taxAmounts.filter((t: any) => t?.inclusive === true || t?.tax_behavior === "inclusive"),
          );
          const lineNet = round2((l.amount ?? 0) / 100 - sumStripeAmounts(l.discount_amounts) - inclusiveTax);
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
            // The price behind the line. Same move as the tax fields: `price` up to
            // 2024, `pricing.price_details.price` from 2025. This is not
            // cosmetic — the Moloni and Vendus adapters read "no SKU and no
            // product id" as a SHIPPING line, so an empty sku here billed
            // "Teste assinatura 1€" to the merchant's customer as "Portes de
            // envio — Teste assinatura 1€" (SenteMente, 04/09/2026).
            sku: l.price?.id ?? l.pricing?.price_details?.price ?? "",
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
      // The PI, not ch.id: a charge and its PaymentIntent describe one sale and
      // must land on one document reference (see stripeStableId).
      invoice_reference: invoiceReference,
      created_at: new Date((ch.created ?? Date.now() / 1000) * 1000).toISOString(),
      note: ch.description ?? null,
      // Charge metadata is the only routable signal on this shape. It used to be
      // dropped, which made tag routing a coin flip: charge.succeeded and
      // payment_intent.succeeded both map to canonical "created" and dedup
      // against each other, so whichever Stripe delivered first decided whether
      // the order had tags at all.
      note_attributes: metadataToNoteAttributes(ch.metadata),
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
      // No per-line breakdown for a Stripe refund — leave line_items empty so the
      // pipeline sets amountToRefund = amount_refunded (partial OR full) and the
      // Moloni cash-delta path credits exactly that amount. A synthetic line here
      // would collide (id:1) with the full-value order item and make the credit
      // note cover the WHOLE invoice instead of the partial refund.
      line_items: [],
    }] : [],
    debits: [],
  };
}

/**
 * Sum a Stripe monetary array (`discount_amounts[]`, `tax_amounts[]`) into
 * major currency units. Both shapes are `[{ amount: <cents>, ... }]`.
 */
function sumStripeAmounts(entries: any): number {
  if (!Array.isArray(entries)) return 0;
  return entries.reduce((s: number, e: any) => s + (Number(e?.amount) || 0), 0) / 100;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Restate a foreign-currency sale in the currency the account settles in.
 *
 * InvoiceXpress issues in the account's own currency — for a Portuguese account
 * that is the euro, and by law it has to be. It will happily print a second
 * currency beside it, but the document's value is the euro one, so 100 AUD has
 * to become 58,20 € before it is sent. Passing the foreign number through would
 * issue a 100 € invoice for a sale of about 58 €.
 *
 * The rate is not fetched from an FX feed: it is read off the payment's own
 * `balance_transaction`, which is what Stripe actually settled at. Using
 * anything else guarantees a document that disagrees with the merchant's bank
 * statement. `amount` and not `net`, because `net` is after Stripe's fee and
 * the merchant sold the gross.
 *
 * Returns true when it converted. Leaves the order untouched otherwise.
 */
function convertToSettlementCurrency(normalized: Normalized, charge: any): boolean {
  const bt = charge?.balance_transaction;
  if (!bt || typeof bt !== "object") return false;

  const settledCode = String(bt.currency ?? "").toUpperCase();
  const paidCode = String(charge.currency ?? "").toUpperCase();
  if (!settledCode || !paidCode || settledCode === paidCode) return false;

  const settledTotal = round2(Number(bt.amount) / 100);
  const paidTotal = round2(Number(charge.amount) / 100);
  if (!(settledTotal > 0) || !(paidTotal > 0)) return false;

  const order = normalized.order;
  const items: any[] = Array.isArray(order.items) ? order.items : [];
  if (items.length === 0) return false;

  const factor = settledTotal / paidTotal;
  for (const item of items) {
    item.unit_price = round2(Number(item.unit_price ?? 0) * factor);
    item.unit_price_calculated = item.unit_price;
    item.subtotal_calculated = item.unit_price;
    if (typeof item.discount_allocation_amount === "number") {
      item.discount_allocation_amount = round2(item.discount_allocation_amount * factor);
    }
    if (item.tax && typeof item.tax.unit_amount === "number") {
      item.tax.unit_amount = round2(item.tax.unit_amount * factor);
    }
  }

  // Converting line by line and rounding each one leaves the sum a cent or two
  // away from the settled total, and the reconcile guard rejects the document
  // over exactly that. Put the residual on the biggest line, where it distorts
  // the unit price least.
  const grossOf = (it: any) =>
    Number(it.unit_price) * Number(it.quantity ?? 1) * (1 + Number(it.tax?.value ?? 0) / 100);
  const sum = round2(items.reduce((acc, it) => acc + grossOf(it), 0));
  const residual = round2(settledTotal - sum);
  if (residual !== 0) {
    let biggest = items[0];
    for (const it of items) if (grossOf(it) > grossOf(biggest)) biggest = it;
    const qty = Number(biggest.quantity ?? 1) || 1;
    const withTax = 1 + Number(biggest.tax?.value ?? 0) / 100;
    biggest.unit_price = round2(biggest.unit_price + residual / qty / withTax);
    biggest.unit_price_calculated = biggest.unit_price;
    biggest.subtotal_calculated = biggest.unit_price;
  }

  order.total = settledTotal;
  order.total_calculated = settledTotal;
  order.currency = settledCode;
  order.shop_currency = settledCode;
  // Six decimals so the foreign figure the document prints lands back on the
  // amount the buyer actually paid: IX derives it as total * rate, and two
  // decimals of rate are worth several cents on a large sale.
  order.paid_in_foreign_currency = {
    code: paidCode,
    amount: paidTotal,
    rate: Math.round((paidTotal / settledTotal) * 1e6) / 1e6,
  };
  console.log(`[Stripe] ${charge.id}: ${paidTotal} ${paidCode} settled as ${settledTotal} ${settledCode} (rate ${order.paid_in_foreign_currency.rate})`);
  return true;
}

/** Does this mapping already know what VAT was charged? */
function carriesTax(normalized: Normalized): boolean {
  return (normalized.order.items ?? []).some((it: any) => Number(it?.tax?.value ?? 0) > 0);
}

/**
 * Where a Stripe payment came from, expressed as tag-routing candidates.
 *
 * A Stripe account collects money from several places at once — a booking
 * plugin creating PaymentIntents through the API, Payment Links and Checkout,
 * invoices the merchant marks as paid outside Stripe — and each stream may have
 * to be filed in its own series. `matchTagRouting` only ever saw order tags and
 * metadata, so a stream whose software writes no metadata was unroutable.
 *
 * Everything here is namespaced `stripe:` so a hint can never collide with a
 * tag or metadata key the merchant wrote themselves, and every value is
 * lowercased so a rule does not depend on Stripe's capitalisation.
 *
 * Only signals that are the SAME for every event describing one payment belong
 * here. A card payment fires session, PaymentIntent and charge events that all
 * dedup onto the PaymentIntent, so a hint that differs between the shapes would
 * make routing a race — which is why `origin` is resolved by looking the sale up
 * rather than read off whichever event arrived (see resolveStripeOrigin).
 */
export function buildStripeRoutingHints(
  objects: any[],
  origin: string | null,
  /** The paid total, for a merchant whose streams are told apart by price. Taken
   *  from the mapped order rather than off a Stripe object so it is the one
   *  number every shape of the payment agrees on. */
  money?: { total: number; currency: string },
): string[] {
  const hints = new Set<string>();
  // A hint with no value is a hint about nothing: an absent field must not
  // produce a bare `stripe:description` that every payment without one matches.
  const add = (name: string, value: unknown) => {
    const v = String(value ?? "").trim().toLowerCase().slice(0, 120);
    if (v) hints.add(`stripe:${name}:${v}`);
  };
  const flag = (name: string) => hints.add(`stripe:${name}`);

  if (origin) add("origin", origin);

  for (const obj of objects) {
    if (!obj || typeof obj !== "object") continue;

    // How the money arrived. `payment_method_details.type` is the charge's, and
    // `payment_method_types` the intent's — the same word either way ("card",
    // "multibanco", "sepa_debit").
    add("payment_method", obj.payment_method_details?.type);
    if (Array.isArray(obj.payment_method_types)) {
      for (const t of obj.payment_method_types) add("payment_method", t);
    }

    // What the payment calls itself. Software that creates payments through the
    // API almost always writes a fixed description even when it writes no
    // metadata, which makes this the fallback discriminator between streams.
    add("description", obj.description);
    add("statement", obj.statement_descriptor ?? obj.statement_descriptor_suffix);

    // A Connect application id — set when a platform or app created the charge.
    if (typeof obj.application === "string") add("application", obj.application);
    add("mode", obj.mode);
    add("billing_reason", obj.billing_reason);

    // Money collected outside Stripe and recorded on a Stripe invoice. The
    // merchant's "marked as paid" stream, with no charge behind it at all.
    if (obj.paid_out_of_band === true) flag("paid_out_of_band");
  }

  // The price itself. Software selling a fixed catalogue — a booking plugin with
  // three services, a class with one ticket price — charges the same few amounts
  // over and over, and when it writes no metadata that is the only thing telling
  // its payments apart from the money the merchant collects by hand.
  //
  // Both forms are offered: `stripe:amount:45.00` reads better in a rule, and
  // `stripe:amount:eur:45.00` is the one to write on an account that takes more
  // than one currency, where 45.00 GBP and 45.00 EUR are different products.
  //
  // Matched exactly, so a discounted or part-paid booking will NOT match and
  // falls to the connection's own series — the safe direction to fail in.
  if (money && Number.isFinite(money.total) && money.total > 0) {
    const amount = money.total.toFixed(2);
    add("amount", amount);
    if (money.currency) add("amount", `${money.currency}:${amount}`);
  }

  return [...hints];
}

/**
 * Which Stripe surface created this sale: `checkout`, `invoice` or `api`.
 *
 * Stable across the three events one card payment fires, because it is answered
 * from the sale itself: an event that IS a session or an invoice answers itself,
 * and a PaymentIntent or charge is resolved by asking Stripe what sits behind
 * it. Returns null when the question could not be answered — no restricted key,
 * or a lookup that errored — because "nothing sits behind this PaymentIntent"
 * and "Stripe did not reply" mean opposite things, and only the first one is
 * `api`.
 */
function stripeOriginOf(
  eventType: string,
  richerEvent: any | null,
  lookupFailed: boolean,
  lookupRan: boolean,
): "checkout" | "invoice" | "api" | null {
  if (eventType === "checkout.session.completed") return "checkout";
  if (eventType.startsWith("invoice.")) return "invoice";
  if (richerEvent?.type === "checkout.session.completed") return "checkout";
  if (richerEvent?.type === "invoice.paid") return "invoice";
  if (lookupRan && !lookupFailed) return "api";
  return null;
}

/**
 * Union of two note_attribute lists, keyed on name+value so re-reading the same
 * metadata from a second Stripe object does not duplicate every entry — a
 * doubled `country:AU` would still route correctly, but a doubled NIF field is
 * the kind of thing the extractor should never have to reason about.
 */
function mergeNoteAttributes(base: any, extra: any): any[] {
  const out: any[] = Array.isArray(base) ? [...base] : [];
  const seen = new Set(out.map(a => `${a?.name} ${a?.value}`));
  for (const attr of Array.isArray(extra) ? extra : []) {
    const key = `${attr?.name} ${attr?.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(attr);
  }
  return out;
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

/** Stamp a recovered buyer name onto both places the destinations read it from
 * (the customer record and the billing address, split into first/last). */
function applyBuyerName(normalized: Normalized, name: string): void {
  if (normalized.order.customer) normalized.order.customer.name = name;
  if (normalized.order.billing_address) {
    normalized.order.billing_address.name = name;
    normalized.order.billing_address.first_name = name.split(" ")[0] ?? "";
    normalized.order.billing_address.last_name = name.split(" ").slice(1).join(" ");
  }
}

export class StripeSource implements SourceAdapter {
  readonly kind = "stripe" as const;

  // Payments are addressable by `pi_`/`ch_`/`cs_`/`in_` id and listable by
  // created-date, and `amount` is the paid total. There are no order numbers,
  // and the event that creates the document IS the payment.
  readonly capabilities = {
    resolveById: true,
    listCandidates: true,
    orderNumberFilter: false,
    paidTotals: true,
    emitsSeparatePaidEvent: false,
  } as const;

  async verifyWebhook(rawBody: string, signature: string, secret: string): Promise<boolean> {
    return verifyStripeSignature(rawBody, signature, secret);
  }

  externalId(parsedBody: any): string {
    // Charge / Checkout Session events collapse onto their PaymentIntent so a
    // single card payment — which fires several of them — deduplicates to one
    // processed_orders row and one document reference. See stripeStableId.
    return stripeStableId(parsedBody);
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

    let stripeCustomer: any = null;
    if (!isSession && restrictedKey && obj?.customer && typeof obj.customer === "string") {
      stripeCustomer = await fetchStripeCustomer(obj.customer, restrictedKey);
      const taxIds = Array.isArray(stripeCustomer?.tax_ids?.data) ? stripeCustomer.tax_ids.data : [];
      if (taxIds.length > 0) {
        const extra = taxIdsToNoteAttributes(taxIds);
        normalized.order.note_attributes = [
          ...(normalized.order.note_attributes ?? []),
          ...extra,
        ];
      }
    }

    // The charge behind the PaymentIntent answers two questions the PI can't:
    // who paid, and WHEN. Fetched once and used for both.
    const isPI = typeof event?.type === "string" && event.type.startsWith("payment_intent.");
    const isCharge = typeof event?.type === "string" && event.type.startsWith("charge.");
    const nameEmpty = !normalized.order.customer?.name?.trim() && !normalized.order.billing_address?.name?.trim();
    let charge: any = null;
    if (restrictedKey && (isPI || isCharge)) {
      // A charge event already IS the charge — no round-trip needed.
      const piId = isPI ? obj?.id : obj?.payment_intent;
      charge = isCharge ? obj : (piId ? await fetchLatestCharge(String(piId), restrictedKey) : null);
    }

    // Buyer-name tier 2: a PaymentIntent carries a name only when pi.shipping was
    // collected, so PI-triggered invoices often come out nameless
    // ("Consumidor Final"). The name usually lives on the charge.
    if (nameEmpty) {
      const chargeName = charge?.billing_details?.name;
      if (typeof chargeName === "string" && chargeName.trim()) applyBuyerName(normalized, chargeName.trim());
    }

    // The document is dated by the PAYMENT, not by the intent to pay. `pi.created`
    // is when the payment was STARTED: for a card that is the same second the
    // money moves, but a Multibanco reference is generated on day one and paid
    // days later (12 days apart on pi_3Tz3w0…). Dating the invoice from the PI
    // asked Moloni for a date well before the series' last document, which then
    // clamped it to the series floor — a date that was neither the intent nor the
    // payment. The charge's `created` is the moment the money arrived.
    if (isPI && Number.isFinite(Number(charge?.created)) && Number(charge.created) > 0) {
      const paidAt = new Date(Number(charge.created) * 1000).toISOString();
      normalized.order.created_at = paidAt;
      if (normalized.order.meta) normalized.order.meta.processed_at = paidAt;
    }

    // The VAT the event does not carry. A PaymentIntent and a charge both map
    // to a single untaxed line, because neither shape has a tax breakdown —
    // Stripe Tax's numbers live on the Checkout Session or the Stripe Invoice
    // behind the payment. Look that up rather than invoice a VAT-charged sale
    // at 0%.
    //
    // Grafts the MONEY only, and only when it agrees with what was paid: the
    // buyer's identity, the document date and the dedup reference all stay as
    // the event decided them, so this cannot move a document to a different
    // customer or a different day. A disagreement means the two objects are not
    // the same sale, and the safe answer is to keep what we had.
    const wantsHints = ctx.config?.stripe_routing_hints === 1;
    const wantsTax = ctx.config?.stripe_tax_from_source === 1 && !carriesTax(normalized);
    const piId = isPI ? String(obj?.id ?? "") : String(obj?.payment_intent ?? "");
    const invoiceId = obj?.invoice ? String(obj.invoice) : (charge?.invoice ? String(charge.invoice) : null);

    // One lookup, two readers. The tax graft and the routing hints both need the
    // richer object behind a PaymentIntent, and asking Stripe twice for the same
    // session would double the calls on every payment for no new information.
    const lookupStatus = { failed: false };
    const lookupRan = restrictedKey != null && restrictedKey !== "" && (isPI || isCharge) && (wantsTax || wantsHints);
    const richerEvent = lookupRan
      ? await fetchRicherTaxSource(piId, invoiceId, restrictedKey!, lookupStatus)
      : null;

    if (wantsTax && restrictedKey && (isPI || isCharge)) {
      const richer = richerEvent ? stripeToNormalized(richerEvent) : null;
      if (richer && carriesTax(richer)) {
        const paid = Number(normalized.order.total);
        const found = Number(richer.order.total);
        if (Number.isFinite(paid) && Number.isFinite(found) && Math.abs(paid - found) <= 0.01) {
          normalized.order.items = richer.order.items;
          // The session also collected what the payment shapes never see: the
          // buyer's tax ids and any custom field they typed a NIF into.
          normalized.order.note_attributes = mergeNoteAttributes(
            normalized.order.note_attributes,
            richer.order.note_attributes,
          );
          console.log(`[Stripe] ${piId || invoiceId}: VAT read from ${richerEvent!.type}`);
        } else {
          console.warn(`[Stripe] ${piId || invoiceId}: ignoring ${richerEvent!.type} — it totals ${found} and the payment was ${paid}`);
        }
      }
    }

    // Routing hints: which stream of the merchant's business this payment came
    // from, for a Stripe account that collects money in more than one way and
    // files each one in its own series. Written to `meta.routing_hints` and NOT
    // to `note_attributes`, which is scanned for a NIF — a synthetic entry there
    // is a fiscal identity waiting to be misread.
    if (wantsHints) {
      const richerObj = richerEvent?.data?.object ?? null;
      const origin = stripeOriginOf(String(event?.type ?? ""), richerEvent, lookupStatus.failed, lookupRan);
      // Before the foreign-currency restatement below, deliberately: a rule is
      // written against the price the buyer was charged, not against its euro
      // equivalent at that day's rate.
      const hints = buildStripeRoutingHints([obj, charge, richerObj], origin, {
        total: Number(normalized.order.total),
        currency: String(normalized.order.currency ?? ""),
      });
      if (hints.length && normalized.order.meta) {
        normalized.order.meta.routing_hints = hints;
      }

      // The metadata the winning event did not carry. Checkout copies session
      // metadata onto the PaymentIntent only when the merchant's software asked
      // it to, so a rule written against a booking plugin's metadata key matched
      // or missed depending on which of the three webhooks Stripe delivered
      // first. Reading it off the session makes the same rule match every time.
      if (richerObj) {
        const richer = stripeToNormalized(richerEvent);
        if (richer) {
          normalized.order.note_attributes = mergeNoteAttributes(
            normalized.order.note_attributes,
            richer.order.note_attributes,
          );
        }
      }
    }

    // What the merchant's own checkout knows and Stripe never asks for. Runs
    // before the currency conversion (it can set the VAT rate, and the
    // conversion restates whatever the lines end up holding) and after every
    // Stripe-sourced tier, because it only fills what is still blank.
    const metadataMap = parseMetadataMap(ctx.config?.stripe_metadata_map);
    if (metadataMap) {
      const filled = applyMetadataMap(normalized, metadataMap);
      const rate = applyMetadataVatRate(normalized, metadataMap);
      if (filled.length > 0 || rate !== null) {
        console.log(`[Stripe] metadata filled ${filled.join(", ") || "nothing"}${rate !== null ? `, VAT ${rate}%` : ""}`);
      }
    }

    // Foreign currency, last of all: the lines have to be final before they are
    // restated, or the conversion runs on numbers the tax lookup above is about
    // to replace. A Checkout Session event never carries the charge, so fetch it
    // here for the currencies that need one.
    if (ctx.config?.ix_multicurrency === 1 && restrictedKey
      && String(normalized.order.currency ?? "EUR").toUpperCase() !== "EUR") {
      let fxCharge = charge;
      if (!fxCharge) {
        const piId = String(obj?.payment_intent ?? obj?.id ?? "");
        if (piId.startsWith("pi_")) fxCharge = await fetchLatestCharge(piId, restrictedKey);
      }
      if (fxCharge) convertToSettlementCurrency(normalized, fxCharge);
    }

    // Last identity tier: the Customer record. Multibanco / Link / off-session
    // subscription charges carry NO name on the charge and NO shipping on the PI,
    // so the two tiers above come back empty and everything the merchant knows
    // about the buyer — name, address, country — sits here. The address matters
    // beyond cosmetics: `billing_address.country_code` is what gates the PT NIF
    // in moloni-destination.resolveOrCreateCustomer, so an empty address threw a
    // perfectly valid NIF away and billed the sale to "Consumidor Final".
    // Only ever FILLS blanks — anything the event itself carried wins.
    if (stripeCustomer) {
      const custName = typeof stripeCustomer.name === "string" ? stripeCustomer.name.trim() : "";
      if (custName && !normalized.order.customer?.name?.trim() && !normalized.order.billing_address?.name?.trim()) {
        applyBuyerName(normalized, custName);
      }
      if (normalized.order.customer && !normalized.order.customer.email && stripeCustomer.email) {
        normalized.order.customer.email = String(stripeCustomer.email);
      }
      const billing = normalized.order.billing_address;
      const addr = stripeCustomer.address;
      if (billing && addr && !billing.address1 && !billing.city && !billing.zip && !billing.country_code) {
        billing.address1 = addr.line1 ?? "";
        billing.address2 = addr.line2 ?? "";
        billing.city = addr.city ?? "";
        billing.province = addr.state ?? "";
        billing.province_code = addr.state ?? "";
        billing.zip = addr.postal_code ?? "";
        billing.country = addr.country ?? "";
        billing.country_code = addr.country ?? "";
        if (!billing.phone && stripeCustomer.phone) billing.phone = String(stripeCustomer.phone);
      }
    }

    return normalized;
  }
}
