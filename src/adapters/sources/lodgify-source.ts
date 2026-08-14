import type { SourceAdapter, AdapterCtx } from "../types";
import type { Normalized, Order } from "../../api/normalize-shopify";
import { bookingCollectedAmount, isOtaStayCollected, otaPolicyFrom } from "../../services/lodgify-amounts";
import { channelReference } from "../../services/lodgify-booking";

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

  // Bookings are addressable by booking id and listable from the D1 mirror;
  // `bookingCollectedAmount` answers what was actually settled. No order
  // numbers, and a booking is only ever billed once it is paid.
  readonly capabilities = {
    resolveById: true,
    listCandidates: true,
    orderNumberFilter: false,
    paidTotals: true,
    emitsSeparatePaidEvent: false,
  } as const;

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
    // Webhook payload has booking.id (new format) or data.bookingId (thin envelope)
    const id = parsedBody?.booking?.id ?? parsedBody?.data?.bookingId ?? parsedBody?.bookingId;
    if (id == null) throw new Error("Lodgify webhook missing booking.id / data.bookingId");
    return String(id);
  }

  async toNormalized(parsedBody: any, ctx: AdapterCtx): Promise<Normalized | null> {
    const bookingId = this.externalId(parsedBody);
    const apiKey = ctx.sourceConfig?.api_key;
    if (!apiKey) throw new Error("Lodgify api_key missing from sourceConfig");

    // Prefer the full webhook payload (booking_change / booking_new_status_booked)
    // which contains all needed fields including payment info. Only fall back to
    // v2 API for admin replay thin envelopes (data.bookingId only, no booking object).
    let booking: any;
    let balanceDue: number | null = null;
    let totalTransactions: number | null = null;

    if (parsedBody._preloaded_booking) {
      // Admin replay: pre-fetched data injected directly (bypasses v2 when rate-limited).
      booking = parsedBody._preloaded_booking;
    } else if (parsedBody.booking?.id) {
      // Full webhook payload — use directly, no API call needed.
      const wb = parsedBody.booking;
      balanceDue = parsedBody.balance_due != null ? Number(parsedBody.balance_due) : null;
      totalTransactions = parsedBody.total_transactions?.amount != null
        ? Number(parsedBody.total_transactions.amount)
        : null;
      const grossFromOrder = parsedBody.current_order?.amount_gross?.amount != null
        ? Number(parsedBody.current_order.amount_gross.amount)
        : null;
      // Normalise webhook shape to match what the v2 API returns
      booking = {
        status: wb.status,
        total: grossFromOrder ?? Number(parsedBody.booking_total_amount ?? 0),
        currency_code: wb.currency_code ?? parsedBody.booking_currency_code ?? "EUR",
        guest: {
          name: parsedBody.guest?.name ?? null,
          email: parsedBody.guest?.email ?? null,
          country_code: parsedBody.guest?.country_code ?? null,
          phone: parsedBody.guest?.phone_number ?? null,
        },
        arrival: wb.date_arrival ? wb.date_arrival.split("T")[0] : "",
        departure: wb.date_departure ? wb.date_departure.split("T")[0] : "",
        property_id: wb.property_id,
        source: wb.source,
        room_type_id: wb.room_types?.[0]?.room_type_id ?? null,
        // Guest comment (booking-form "Comentários" box → NIF). `note` is the only
        // free-text guest field Lodgify exposes on the booking; the rest are
        // future-proofing. NOT source_text — that is the channel label.
        notes: firstNonEmpty(
          wb.note, wb.notes, parsedBody.note, parsedBody.notes, parsedBody.comment,
          parsedBody.guest?.comment, parsedBody.guest?.notes, parsedBody.guest?.message,
        ),
      };
    } else {
      // Thin envelope (data.bookingId only) — fetch from v2 API.
      const res = await fetch(`https://api.lodgify.com/v2/reservations/${bookingId}`, {
        headers: { "X-ApiKey": apiKey, "Accept": "application/json" },
      });
      if (!res.ok) {
        throw new Error(`Lodgify GET /v2/reservations/${bookingId} → ${res.status} ${res.statusText}`);
      }
      booking = await res.json();
    }

    const status = String(booking.status ?? "").toLowerCase();
    // Detect refund path: booking_status_change_declined event
    const isDeclined = status === "declined"
      || String(parsedBody?.action ?? parsedBody?.event ?? "").includes("declined");

    if (!isDeclined && status !== "booked") {
      console.log(`[Lodgify] Booking ${bookingId} status="${booking.status}" — skipping invoice`);
      return null;
    }

    // Payment gate (invoice path only).
    //
    // This ran as `balanceDue > 0 ⇒ skip`, which passes a booking whose balance
    // is zero because nobody ever owed Lodgify anything — the OTA case that
    // billed a fleet of future reservations through the poll. The poll is fixed;
    // this door has to be shut too, or registering Lodgify webhooks (partner
    // OAuth, still pending) would silently reintroduce the same bug.
    //
    // Only applies to real webhook payloads. `_preloaded_booking` arrives from
    // the poll, which has ALREADY applied this rule — and on the progressive
    // path deliberately bills a partial amount, which this gate would reject.
    if (!isDeclined && !parsedBody._preloaded_booking && !parsedBody._force) {
      const settlement = bookingCollectedAmount({
        total_amount: Number(booking.total ?? 0),
        // Webhook payloads carry the amounts at the envelope level; a thin
        // envelope resolved through the v2 API carries them on the booking
        // itself. Read both, or the gate judges a v2-fetched booking on nulls
        // and holds everything.
        amount_paid: totalTransactions ?? booking.amount_paid ?? booking.total_paid,
        amount_due: balanceDue ?? booking.amount_due ?? booking.balance_due,
      });
      // The opted-in OTA rule has to be honoured here too, or the day Lodgify
      // partner webhooks land this gate would start holding exactly the stays
      // the poll bills — the same divergence that made the webhook path carry
      // the `amount_due == 0` bug months after the poll was fixed.
      const otaCollected = isOtaStayCollected(
        { ...booking, total_amount: booking.total, source: booking.source },
        otaPolicyFrom(ctx.destinationConfig),
      );
      if (!otaCollected && settlement.collected + 0.01 < Number(booking.total ?? 0)) {
        console.log(`[Lodgify] Booking ${bookingId} not billable yet (${settlement.basis}, due=${balanceDue}) — skipping`);
        return null;
      }
    }

    // Refund path: only issue credit note when something was actually paid.
    const amountPaid = totalTransactions ?? Number(booking.total ?? 0);
    if (isDeclined && amountPaid <= 0) {
      console.log(`[Lodgify] Booking ${bookingId} declined but no payments recorded — skipping credit note`);
      return null;
    }

    // Partial (instalment) invoicing: the poll passes `_partial.amount` = the
    // newly-paid delta to bill on THIS document (the rest comes on later
    // instalments), plus a distinct reference and a "parcela" note.
    const partial = parsedBody?._partial as { seq?: number; amount?: number; reference?: string; note?: string } | undefined;
    // For refunds, use the amount paid (total_transactions.amount) as the gross to credit.
    const grossTotal = partial ? Number(partial.amount ?? 0)
      : isDeclined ? amountPaid : Number(booking.total ?? 0);
    const currency = String(booking.currency_code ?? "EUR").toUpperCase();

    // PT default: 6% IVA (alojamento local, Lista I Verba 2.17 CIVA).
    // Override via integrations.force_tax_rate for edge cases (e.g. rural turismo = 0%).
    const taxRate = ctx.config.force_tax_rate != null ? Number(ctx.config.force_tax_rate) : 6;
    const netUnit = taxRate > 0
      ? Math.round((grossTotal / (1 + taxRate / 100)) * 10000) / 10000
      : grossTotal;

    // Enrich guest with full contact details (address, postal code, split name,
    // notes). The v2 booking object only carries name/email/phone/country_code;
    // the v1 reservation endpoint additionally exposes street_address, city,
    // postal_code and state — all of which Moloni wants on the customer record.
    // Best-effort: a v1 failure must never block invoicing.
    //
    // Skipped when the caller already merged that detail into the booking item
    // (`_enriched`): with Lodgify blocking this Worker's egress, the call would
    // burn a guaranteed-429 request per document and return nothing we don't
    // already have.
    const enriched = booking._enriched ? null : await fetchGuestDetails(bookingId, apiKey);

    const guestName = enriched?.fullName || booking.guest?.name || "Consumidor Final";
    const guestEmail = String(enriched?.email ?? booking.guest?.email ?? "");
    const rawCountry = String(enriched?.countryCode ?? booking.guest?.country_code ?? "PT").toUpperCase();
    const countryName = countryCodeToName(rawCountry);
    const guestPhone = enriched?.phone ?? booking.guest?.phone ?? null;
    // NIF is not a native Lodgify field; it only appears when the guest typed it
    // into the booking-form "Comentários" box (data-testid contact-comments-input).
    // Surface that comment on order.note so the destination's extractPtNif (which
    // scans order.note for a valid 9-digit PT NIF) picks it up. We combine BOTH
    // the v1-enriched note and the webhook/poll `booking.notes` because the
    // comment can arrive via either — the poll path has no v1 call to depend on.
    // If the guest typed "N/A" (or a variant, or nothing), no valid NIF is found
    // and the destination falls back to the generic consumer VAT (999999990).
    const guestNote = stripNaOnly(firstNonEmpty(
      enriched?.note,
      booking.notes != null ? String(booking.notes) : null,
    ));

    const arrival = String(booking.arrival ?? "");
    const departure = String(booking.departure ?? "");
    // Document date = the date of ISSUE, not the check-in date.
    //
    // This used to be the arrival date, which put a FUTURE date on every
    // document for a stay that had not happened yet — the merchant's Moloni list
    // showed invoices dated in September, issued in August. A fiscal document is
    // dated when it is issued; the stay it covers is expressed in the line
    // description ("Alojamento <arrival> - <departure>"), which is where a
    // reader looks for it.
    const bookingDateIso = new Date().toISOString();

    const refStr = `LOD-${bookingId}`;
    const orderNumeric = numericFromId(bookingId);

    const nameParts = guestName.split(" ");
    const firstName = enriched?.firstName || nameParts[0] || "Consumidor";
    const lastName = enriched?.lastName || nameParts.slice(1).join(" ") || "Final";

    const addr = {
      first_name: firstName,
      last_name: lastName,
      name: guestName,
      company: null as string | null,
      // Enrichment wins when it works; the preloaded booking carries the same
      // fields when the caller merged the v1 detail on our behalf. Before this
      // fallback existed, a blocked enrichment meant every Moloni customer was
      // created with a blank address, silently.
      address1: enriched?.address1 ?? booking.guest?.address1 ?? "",
      address2: enriched?.address2 ?? booking.guest?.address2 ?? "",
      city: enriched?.city ?? booking.guest?.city ?? "",
      province: enriched?.state ?? booking.guest?.state ?? "",
      province_code: "",
      zip: enriched?.zip ?? booking.guest?.zip ?? "",
      country: countryName,
      country_code: rawCountry,
      phone: guestPhone,
    };

    const baseTitle = [arrival, departure].every(Boolean)
      ? `Alojamento ${arrival} - ${departure}`
      : "Alojamento";
    const lineTitle = partial?.seq ? `${baseTitle} (parcela ${partial.seq})` : baseTitle;

    const makeLine = (id: number, title: string, gross: number, rate: number, sku = refStr) => {
      const net = rate > 0 ? Math.round((gross / (1 + rate / 100)) * 10000) / 10000 : gross;
      return {
        id,
        product_id: 0,
        variant_id: 0,
        quantity: 1,
        unit_price: net,
        unit_price_calculated: net,
        subtotal_calculated: net,
        tax: { name: "IVA", value: rate, unit_amount: rate },
        discount: { name: "", percent: 0 },
        title,
        variant_title: null,
        sku,
        fulfilled: true,
        fulfilled_quantity: 1,
        fulfillment_status: "fulfilled",
      };
    };

    // Cleaning fees and add-ons at their own VAT rate, when the merchant asked
    // for the split and Lodgify actually told us the breakdown.
    //
    // The v1 list — which is all the poll ever sees — reports a single
    // `total_amount`. The breakdown lives on the v2 booking
    // (`subtotals: {stay, fees, addons, …}`), so it only exists here when
    // whoever built the payload fetched it. No breakdown ⇒ one line at the
    // accommodation rate, which is the behaviour every other connection keeps.
    const extrasRate = Number(ctx.destinationConfig?.lodgify_extras_vat_rate ?? 0);
    const subtotals = (booking as any).subtotals;
    const extrasGross = extrasRate > 0 && subtotals && !partial && !isDeclined
      ? Math.round((Number(subtotals.fees ?? 0) + Number(subtotals.addons ?? 0)) * 100) / 100
      : 0;
    // Split only when the arithmetic closes on the total we are billing. A
    // breakdown that does not add up is a breakdown we do not understand, and
    // guessing would put a wrong tax base on a fiscal document.
    const stayGross = Math.round((grossTotal - extrasGross) * 100) / 100;
    const splitExtras = extrasGross > 0.01 && stayGross > 0.01;

    const lineItems = splitExtras
      ? [
          makeLine(1, lineTitle, stayGross, taxRate),
          // Its own SKU, and therefore its own Moloni product: the destination
          // derives the product reference from the SKU, so sharing one would
          // put the cleaning fee on a product named after the stay and carrying
          // the accommodation's 6% tax rule.
          makeLine(2, "Limpeza e extras", extrasGross, extrasRate, `${refStr}-LIM`.slice(0, 30)),
        ]
      : [makeLine(1, lineTitle, grossTotal, taxRate)];

    // Populate note_attributes so tag routing rules can match on booking fields.
    // Merchants route by property_id (multi-property) or booking source (channel).
    const noteAttrs: Array<{ name: string; value: string }> = [];
    if (booking.property_id != null) {
      noteAttrs.push({ name: "property_id", value: String(booking.property_id) });
    }
    if (booking.source) {
      noteAttrs.push({ name: "source", value: String(booking.source).toLowerCase() });
    }
    if (booking.room_type_id != null) {
      noteAttrs.push({ name: "room_type_id", value: String(booking.room_type_id) });
    }
    // Also expose the guest comment as a "nif" attribute. extractPtNif's keyword
    // branch strips ALL non-digits and takes the last 9, so this catches NIFs
    // glued to text (e.g. "NIF123456789") that the order.note word-boundary scan
    // (\b\d{9}\b) would miss. Only added when the comment survived the N/A strip.
    if (guestNote) {
      noteAttrs.push({ name: "nif", value: guestNote });
    }

    const order: Order = {
      id: orderNumeric,
      reference: refStr,
      order_number: orderNumeric,
      created_at: bookingDateIso,
      // Instalment note (e.g. "Parcela 1 — 50% …") prepended, keeping the guest
      // note so a NIF typed there is still picked up by extractPtNif.
      note: partial ? [partial.note, guestNote].filter(Boolean).join(" | ") || null : guestNote,
      note_attributes: noteAttrs,
      // The channel's own reference ("Airbnb HMMZDXRCN9"), stamped on the
      // document so an OTA stay can be traced back to the payout that covers
      // it — the only link there is, since the money never passes through
      // Lodgify. Its own field, never `note`: that one is scanned for a NIF.
      channel_reference: (booking as any).channel_reference ?? channelReference(booking) ?? null,
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
      items: lineItems,
      global_discount: { name: "", percent: 0, amount: 0 },
      invoice_reference: partial?.reference ?? null,
    };

    // For declined bookings, build a credit entry covering the full paid amount.
    // The pipeline's "refund" topic reads credits[] and calls issueCredit() per entry.
    // amountToRefund = credit.amount - sum(line_items.subtotal) is the delta passed
    // to issueCredit; we keep both equal so no extra delta line is added.
    const credits = isDeclined ? [{
      refund_id: orderNumeric,
      amount: netUnit, // net so delta = 0; tax handled by Moloni product settings
      line_items: [{
        id: lineItems[0].id,
        quantity: 1,
        subtotal: netUnit,
        total_tax: Math.round((grossTotal - netUnit) * 100) / 100,
      }],
    }] : [];

    return {
      order,
      refunds: [],
      exchanges: [],
      credits,
      debits: [],
    };
  }
}

// First non-empty trimmed string among vals, or null.
function firstNonEmpty(...vals: Array<unknown>): string | null {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s.length > 0) return s;
  }
  return null;
}

// If the comment is ONLY an "N/A" variant (guest has no NIF), drop it so it
// isn't stamped on the invoice as a bogus note. A comment that also carries a
// real NIF (e.g. "N/A depois 123456789") is kept intact for extractPtNif.
// The generic-VAT fallback (999999990) then applies when no valid NIF remains.
function stripNaOnly(note: string | null): string | null {
  if (!note) return null;
  const t = note.trim();
  // n/a, na, n.a., "não tenho", "sem nif", "nao possuo", "-", "—" …
  if (/^(n\.?\/?\s*a\.?|n[aã]o\s+(tenho|possuo|tem)|sem\s+nif|nenhum|none|[-–—.]+)$/i.test(t)) {
    return null;
  }
  return note;
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

type GuestDetails = {
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  zip: string | null;
  state: string | null;
  countryCode: string | null;
  note: string | null;
};

// The v1 reservation endpoint carries the full guest record (postal address,
// split name, notes) that v2's booking object omits. Best-effort enrichment —
// any failure returns null and the caller falls back to the v2/webhook guest.
async function fetchGuestDetails(bookingId: string, apiKey: string): Promise<GuestDetails | null> {
  try {
    const res = await fetch(`https://api.lodgify.com/v1/reservation/booking/${bookingId}`, {
      headers: { "X-ApiKey": apiKey, "Accept": "application/json" },
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const g = data?.guest;
    if (!g) return null;
    const clean = (v: unknown): string | null => {
      const s = v == null ? "" : String(v).trim();
      return s.length > 0 ? s : null;
    };
    const phone = clean(g.phone) ?? clean(Array.isArray(g.phone_numbers) ? g.phone_numbers[0] : null);
    return {
      firstName: clean(g.guest_name?.first_name),
      lastName: clean(g.guest_name?.last_name),
      fullName: clean(g.guest_name?.full_name) ?? clean(g.name),
      email: clean(g.email),
      phone,
      address1: clean(g.street_address1),
      address2: clean(g.street_address2),
      city: clean(g.city),
      zip: clean(g.postal_code),
      state: clean(g.state),
      countryCode: clean(g.country_code),
      // Guest comment. `data.note` is the only free-text guest field the v1
      // booking exposes (verified live); the rest are future-proofing. NOT
      // source_text — that is the channel label ("Direto", "*.lodgify.com").
      note: firstNonEmpty(
        clean(data?.note), clean(data?.comment), clean(data?.message),
        clean(g.comment), clean(g.notes), clean(g.message),
      ),
    };
  } catch {
    // Non-fatal: enrichment is additive; invoice still issues without it.
    return null;
  }
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
