import type { SourceAdapter, AdapterCtx } from "../types";
import type { Normalized } from "../../api/normalize-shopify";

/**
 * EuPagoSource — Realtime Webhooks 2.0 (https://eupago.readme.io/reference/realtime-webhooks-20).
 *
 * Webhook envelope:
 *   POST <merchant-callback-url>
 *   Headers:
 *     X-Signature: <base64(HMAC-SHA256(rawBody, hmac_secret))>
 *     X-Initialization-Vector: <base64-iv>   (only when payload is AES-256-CBC encrypted)
 *     Content-Type: application/json
 *   Body (when not encrypted):
 *     {
 *       entity, reference, identifier, method,
 *       amount: { amount, currency },
 *       fees:   { amount, currency },
 *       date, trid, status, channel: { name }
 *     }
 *   Status values: PAID | REFUNDED | ERROR | CANCELED | EXPIRED.
 *
 * Limitations of this adapter:
 *   - AES-256-CBC payload encryption is NOT supported yet. The merchant must
 *     disable encryption in the EuPago backoffice. We surface this in the UI.
 *   - The payload carries NO customer name / NIF / email. We invoice every
 *     PAID event to "Consumidor Final" — valid for PT B2C up to 1000€ per
 *     transação simplificada. Merchants needing structured customer data
 *     should use Shopify or Stripe Checkout sources instead.
 *   - REFUNDED is mapped to canonical topic "refund" and assumes the original
 *     invoice was issued via this same source (externalId = trid).
 */
export class EuPagoSource implements SourceAdapter {
  readonly kind = "eupago" as const;

  async verifyWebhook(rawBody: string, signatureHeader: string, secret: string): Promise<boolean> {
    if (!signatureHeader || !secret) return false;

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const macBuf = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
    const expected = new Uint8Array(macBuf);

    const provided = base64ToBytes(signatureHeader.trim());
    if (!provided || provided.length !== expected.length) return false;

    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= provided[i] ^ expected[i];
    return diff === 0;
  }

  externalId(parsedBody: any): string {
    // `trid` is EuPago's server-assigned transaction id — stable across retries
    // and refunds. Fall back to `identifier` (merchant-supplied) if absent.
    const trid = parsedBody?.trid;
    if (trid !== undefined && trid !== null) return String(trid);
    if (parsedBody?.identifier) return String(parsedBody.identifier);
    throw new Error("EuPago webhook missing trid/identifier");
  }

  async toNormalized(parsedBody: any, ctx: AdapterCtx): Promise<Normalized | null> {
    const body = parsedBody ?? {};
    const status = String(body.status ?? "").toUpperCase();

    // Only PAID and REFUNDED produce invoiceable events.
    // ERROR / CANCELED / EXPIRED → no invoice. Returning null = pipeline skips.
    if (status !== "PAID" && status !== "REFUNDED") return null;

    const isRefund = status === "REFUNDED";

    const amount = Number(body.amount?.amount ?? 0);
    const currency = String(body.amount?.currency ?? "EUR").toUpperCase();
    const method = String(body.method ?? "EuPago");
    const trid = String(body.trid ?? body.identifier ?? "");
    const dateIso = parseDate(body.date) ?? new Date().toISOString();

    // PT B2C default: 23% normal rate unless merchant overrides via
    // integrations.force_tax_rate (Dev Mode). EuPago `amount` is the gross
    // figure the customer actually paid — invariant: invoice gross MUST
    // equal `amount`. We emit a NET unit_price so the destination adapter
    // (which treats unit_price as VAT-exclusive per the IX convention) lands
    // on `amount` after re-applying tax. Round to 4dp on the net to absorb
    // sub-cent precision; reconcileTotalOrThrow guards the final total.
    const taxRate = ctx.config.force_tax_rate != null ? Number(ctx.config.force_tax_rate) : 23;
    const netUnit = taxRate > 0
      ? Math.round((amount / (1 + taxRate / 100)) * 10000) / 10000
      : amount;

    const customerName = "Consumidor Final";
    const orderId = numericIdFromTrid(trid);

    const lineItem = {
      id: 1,
      product_id: 0,
      variant_id: 0,
      quantity: 1,
      unit_price: netUnit,
      unit_price_calculated: netUnit,
      subtotal_calculated: netUnit,
      tax: { name: "VAT", value: taxRate, unit_amount: taxRate },
      discount: { name: "", percent: 0 },
      title: `Pagamento ${method} (ref ${body.reference ?? body.identifier ?? trid})`,
      variant_title: null,
      sku: trid,
      fulfilled: true,
      fulfilled_quantity: 1,
      fulfillment_status: "fulfilled",
    };

    const baseOrder: Normalized["order"] = {
      id: orderId,
      reference: trid,
      order_number: orderId,
      created_at: dateIso,
      note: null,
      note_attributes: [],
      metafields: null,
      tags: [],
      meta: {
        device_id: null,
        token: trid,
        source_name: "eupago",
        browser_ip: "",
        payment_gateway_names: ["eupago", method.toLowerCase()],
        source_identifier: String(body.identifier ?? trid),
        confirmation_number: trid,
        processed_at: dateIso,
      },
      total: amount,
      total_calculated: amount,
      currency,
      shop_currency: currency,
      exchange_rate: 1,
      financial_status: isRefund ? "refunded" : "paid",
      fulfillment_status: null,
      customer: {
        id: 0,
        email: "",
        name: customerName,
        created_at: dateIso,
        default_address: emptyAddress(customerName),
        address: emptyAddress(customerName),
      },
      billing_address: emptyAddress(customerName),
      shipping_address: emptyAddress(customerName),
      items: [lineItem],
      global_discount: { name: "", percent: 0, amount: 0 },
    };

    if (!isRefund) {
      return {
        order: baseOrder,
        refunds: [],
        exchanges: [],
        credits: [],
        debits: [],
      };
    }

    // REFUNDED: pipeline `case "refund"` iterates `credits[]` and emits a
    // credit note per row against the original invoice referenced by externalId.
    return {
      order: baseOrder,
      refunds: [],
      exchanges: [],
      credits: [{
        refund_id: trid,
        amount,
        line_items: [{ id: 1, subtotal: amount, quantity: 1, name: lineItem.title }],
      } as any],
      debits: [],
    };
  }
}

function base64ToBytes(s: string): Uint8Array | null {
  try {
    const binary = atob(s);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function parseDate(input: any): string | null {
  if (!input) return null;
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function numericIdFromTrid(trid: string): number {
  // Many downstream consumers expect order.id as a number; derive a stable
  // numeric id from the trid by stripping non-digits and keeping the last 12.
  const digits = trid.replace(/\D/g, "").slice(-12);
  return Number(digits) || 0;
}

function emptyAddress(name: string) {
  return {
    first_name: "Consumidor",
    last_name: "Final",
    name,
    company: null,
    address1: "",
    address2: "",
    city: "",
    province: "",
    province_code: "",
    zip: "",
    country: "Portugal",
    country_code: "PT",
    phone: null,
  };
}
