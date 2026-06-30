import type { SourceAdapter, AdapterCtx } from "../types";
import type { Normalized, Order } from "../../api/normalize-shopify";

/**
 * LodgifySource — Lodgify PMS webhook integration.
 *
 * Webhook envelope (POST /webhooks/lodgify/{userId}):
 *   Headers:
 *     ms-signature: sha256=<hex_hmac_sha256>
 *     Content-Type: application/json
 *   Body (thin envelope — no booking data):
 *     { "event": "booking_new_booked", "data": { "bookingId": 12345 } }
 *
 * Full booking fetched via GET https://api.lodgify.com/v2/reservations/{id}
 * using the stored api_key (X-ApiKey header).
 *
 * Only "Booked" status bookings produce invoices. Others return null → pipeline skips.
 *
 * Tax: PT accommodation defaults to 6% IVA taxa reduzida (Lista I, Verba 2.17 CIVA).
 * Overridable via integrations.force_tax_rate (Dev Mode).
 *
 * Refund handling: Phase 2. Only booking_new_booked is registered at setup time.
 */
export class LodgifySource implements SourceAdapter {
  readonly kind = "lodgify" as const;

  async verifyWebhook(rawBody: string, signatureHeader: string, secret: string): Promise<boolean> {
    if (!signatureHeader || !secret) return false;

    // Header format: "sha256=<hex>" — strip prefix
    const hex = signatureHeader.startsWith("sha256=") ? signatureHeader.slice(7) : signatureHeader.trim();
    if (!hex) return false;

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const macBuf = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
    const computed = Array.from(new Uint8Array(macBuf))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    return timingSafeEqual(computed, hex);
  }

  externalId(parsedBody: any): string {
    const id = parsedBody?.data?.bookingId ?? parsedBody?.bookingId;
    if (id == null) throw new Error("Lodgify webhook missing data.bookingId");
    return String(id);
  }

  async toNormalized(parsedBody: any, ctx: AdapterCtx): Promise<Normalized | null> {
    const bookingId = this.externalId(parsedBody);
    const apiKey = ctx.sourceConfig?.api_key;
    if (!apiKey) throw new Error("Lodgify api_key missing from sourceConfig");

    const res = await fetch(`https://api.lodgify.com/v2/reservations/${bookingId}`, {
      headers: { "X-ApiKey": apiKey, "Accept": "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Lodgify GET /v2/reservations/${bookingId} → ${res.status} ${res.statusText}`);
    }
    const booking: any = await res.json();

    const status = String(booking.status ?? "").toLowerCase();
    if (status !== "booked") {
      // Tentative / Open / Declined → not invoiceable yet
      console.log(`[Lodgify] Booking ${bookingId} status="${booking.status}" — skipping invoice`);
      return null;
    }

    const grossTotal = Number(booking.total ?? 0);
    const currency = String(booking.currency_code ?? "EUR").toUpperCase();

    // PT default: 6% IVA (alojamento local, Lista I Verba 2.17 CIVA).
    // Override via integrations.force_tax_rate for edge cases (e.g. rural turismo = 0%).
    const taxRate = ctx.config.force_tax_rate != null ? Number(ctx.config.force_tax_rate) : 6;
    const netUnit = taxRate > 0
      ? Math.round((grossTotal / (1 + taxRate / 100)) * 10000) / 10000
      : grossTotal;

    const guestName = booking.guest?.name || "Consumidor Final";
    const guestEmail = String(booking.guest?.email ?? "");
    const rawCountry = String(booking.guest?.country_code ?? "PT").toUpperCase();
    const countryName = countryCodeToName(rawCountry);

    const arrival = String(booking.arrival ?? "");
    const departure = String(booking.departure ?? "");
    const bookingDateIso = arrival ? `${arrival}T12:00:00Z` : new Date().toISOString();

    const refStr = `LOD-${bookingId}`;
    const orderNumeric = numericFromId(bookingId);

    const nameParts = guestName.split(" ");
    const firstName = nameParts[0] ?? "Consumidor";
    const lastName = nameParts.slice(1).join(" ") || "Final";

    const addr = {
      first_name: firstName,
      last_name: lastName,
      name: guestName,
      company: null as string | null,
      address1: "",
      address2: "",
      city: "",
      province: "",
      province_code: "",
      zip: "",
      country: countryName,
      country_code: rawCountry,
      phone: booking.guest?.phone ?? null,
    };

    const lineTitle = [arrival, departure].every(Boolean)
      ? `Alojamento ${arrival} - ${departure}`
      : "Alojamento";

    const lineItem = {
      id: 1,
      product_id: 0,
      variant_id: 0,
      quantity: 1,
      unit_price: netUnit,
      unit_price_calculated: netUnit,
      subtotal_calculated: netUnit,
      tax: { name: "IVA", value: taxRate, unit_amount: taxRate },
      discount: { name: "", percent: 0 },
      title: lineTitle,
      variant_title: null,
      sku: refStr,
      fulfilled: true,
      fulfilled_quantity: 1,
      fulfillment_status: "fulfilled",
    };

    const order: Order = {
      id: orderNumeric,
      reference: refStr,
      order_number: orderNumeric,
      created_at: bookingDateIso,
      note: null,
      note_attributes: [],
      metafields: null,
      tags: [],
      meta: {
        device_id: null,
        token: refStr,
        source_name: "lodgify",
        browser_ip: "",
        payment_gateway_names: ["lodgify"],
        source_identifier: refStr,
        confirmation_number: refStr,
        processed_at: bookingDateIso,
      },
      total: grossTotal,
      total_calculated: grossTotal,
      currency,
      shop_currency: currency,
      exchange_rate: 1,
      financial_status: "paid",
      fulfillment_status: null,
      customer: {
        id: 0,
        email: guestEmail,
        name: guestName,
        created_at: bookingDateIso,
        default_address: addr,
        address: addr,
      },
      billing_address: addr,
      shipping_address: addr,
      items: [lineItem],
      global_discount: { name: "", percent: 0, amount: 0 },
    };

    return {
      order,
      refunds: [],
      exchanges: [],
      credits: [],
      debits: [],
    };
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function numericFromId(id: string | number): number {
  const digits = String(id).replace(/\D/g, "").slice(-12);
  return Number(digits) || 0;
}

// Minimal country code → name map for IX (needs full name, not ISO code).
// Only the most common codes for PT Alojamento Local guests.
const COUNTRY_NAMES: Record<string, string> = {
  PT: "Portugal", ES: "Espanha", FR: "França", DE: "Alemanha", GB: "Reino Unido",
  US: "Estados Unidos", IT: "Itália", NL: "Países Baixos", BE: "Bélgica",
  CH: "Suíça", BR: "Brasil", CA: "Canadá", AU: "Austrália", PL: "Polónia",
  SE: "Suécia", NO: "Noruega", DK: "Dinamarca", FI: "Finlândia", AT: "Áustria",
  IE: "Irlanda", LU: "Luxemburgo", CZ: "República Checa", HU: "Hungria",
  RO: "Roménia", MX: "México", AR: "Argentina", ZA: "África do Sul",
  JP: "Japão", CN: "China", KR: "Coreia do Sul", IN: "Índia",
};

function countryCodeToName(code: string): string {
  return COUNTRY_NAMES[code] ?? code;
}
