import { firstNum } from "./lodgify-amounts";

/**
 * Turning a Lodgify booking item into the shape the pipeline reads.
 *
 * Lived in src/index.ts, which put it out of reach of the recovery layer — and
 * the recovery layer has to build exactly the same payload the poll builds, or a
 * re-emitted booking would be normalized from a different set of fields than the
 * one that billed it in the first place.
 */

/** First non-empty string among vals, else null. */
export function firstStr(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s.length > 0) return s;
  }
  return null;
}

/**
 * The channel's own booking reference, for stamping on the document.
 *
 * Lodgify hides it in `source_text`, whose shape depends on the channel:
 *   Airbnb      → a JSON blob; the human-facing code is `confirmationCode`
 *                 ("HMMZDXRCN9"). The listing/thread ids in there are noise.
 *   Booking.com → "5670891596|6375058873"; the first field is the reservation
 *                 number the host sees in the extranet.
 *   Direct/manual → a label ("Direto", "Lodgify", "vilalaura.lodgify.com"), or
 *                 once, a phone number. Not a reference — return null.
 *
 * Returns "<Channel> <ref>" so the document says which channel it came from,
 * because "HMMZDXRCN9" alone means nothing to an accountant.
 */
export function channelReference(item: any): string | null {
  const source = String(item?.source ?? "");
  const raw = item?.source_text;
  if (raw == null || String(raw).trim() === "") return null;

  const text = String(raw).trim();
  const s = source.toLowerCase();

  if (s.includes("airbnb")) {
    try {
      const parsed = JSON.parse(text);
      const code = firstStr(parsed?.confirmationCode, parsed?.confirmation_code);
      return code ? `Airbnb: ${code}` : null;
    } catch {
      // Not JSON — some payloads carry the bare code.
      return /^[A-Z0-9]{6,20}$/i.test(text) ? `Airbnb: ${text}` : null;
    }
  }

  if (s.includes("booking")) {
    // "5670891596|6375058873" — the reservation number the host sees, then a
    // second id. Both are kept, separated by " ! ", because either can be the
    // one that appears on a given payout statement.
    const parts = text.split("|").map((p) => p.trim()).filter((p) => /^\d{4,}$/.test(p));
    return parts.length ? `Booking.com: ${parts.join(" ! ")}` : null;
  }

  // Any other channel: keep it only when it looks like an id, never a label.
  if (/^[A-Z0-9][A-Z0-9-]{5,}$/i.test(text) && !/^https?:|lodgify|direto|direct$/i.test(text)) {
    return source ? `${source}: ${text}` : text;
  }
  return null;
}

/** YYYY-MM-DD prefix of a date-ish value, or "" when there isn't one. */
export function ymd(input: unknown): string {
  const m = String(input ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

/**
 * Map a Lodgify booking item into the shape `LodgifySource` reads from
 * `_preloaded_booking`.
 *
 * NOTE for anyone building this payload: supplying `_preloaded_booking` makes
 * LodgifySource SKIP its settlement gate, on the grounds that the caller has
 * already applied it (see the comment at lodgify-source.ts). Any new caller must
 * therefore decide for itself whether the booking is billable — handing this to
 * the pipeline is asserting that it is.
 */
export function toPreloadedFromItem(item: any): Record<string, unknown> {
  return {
    status: item?.status,
    total: firstNum(item?.total_amount, item?.total) ?? 0,
    // How much of that total has been collected, and what is outstanding.
    //
    // The gate is applied by the caller (see the note above), so these are NOT
    // here to decide billability — they are here so the source can SAY what the
    // settlement is. A connection on `invoice_plus_receipts` routes a part-paid
    // stay to a Fatura through a `settlement:instalment` tag rule, and without
    // the amounts the source computed "awaiting_payment" from two undefineds,
    // no rule matched, and a stay with half the money in the bank was issued as
    // a Fatura/Recibo — a document whose whole assertion is that it was paid.
    amount_paid: firstNum(item?.amount_paid, item?.total_paid),
    amount_due: firstNum(item?.amount_due, item?.amount_to_pay, item?.balance_due),
    currency_code: item?.currency_code ?? "EUR",
    guest: {
      name: item?.guest?.name ?? item?.guest?.guest_name?.full_name ?? null,
      email: item?.guest?.email ?? null,
      country_code: item?.guest?.country_code ?? null,
      phone: item?.guest?.phone ?? item?.guest?.phone_number ?? null,
      // Postal address, when the item carries it. The booking LIST does not, but
      // an item enriched from `/v1/reservation/booking/{id}` does — and that is
      // now the only way the address survives, because the Worker's own call to
      // that endpoint is what Lodgify blocks. Field names are v1's own.
      address1: item?.guest?.street_address1 ?? item?.guest?.address1 ?? null,
      address2: item?.guest?.street_address2 ?? item?.guest?.address2 ?? null,
      city: item?.guest?.city ?? null,
      zip: item?.guest?.postal_code ?? item?.guest?.zip ?? null,
      state: item?.guest?.state ?? null,
    },
    // Set by whoever already merged the v1 detail into this item, to stop the
    // pipeline making a per-document call that is guaranteed to be blocked.
    // A marker, not a guess from field truthiness: a guest who genuinely has no
    // address must not permanently suppress an enrichment that may start working
    // again the day partner registration lands.
    _enriched: item?._enriched === true,
    arrival: ymd(item?.arrival ?? item?.date_arrival),
    departure: ymd(item?.departure ?? item?.date_departure),
    property_id: item?.property_id ?? null,
    source: item?.source ?? null,
    source_text: item?.source_text ?? null,
    // Present only when the caller fetched the v2 booking: {stay, fees, addons,
    // taxes, …}. The v1 list the poll reads reports a single total, so a
    // connection that splits extras onto their own VAT rate depends on whoever
    // built this payload having gone and got it.
    subtotals: item?.subtotals ?? null,
    // "Airbnb HMMZDXRCN9" / "Booking.com 5670891596". Kept as its own field and
    // deliberately NOT folded into `notes`: that one is scanned for a 9-digit
    // Portuguese NIF, and a channel reference is exactly the kind of digit run
    // that would be mistaken for one.
    channel_reference: channelReference(item),
    room_type_id: item?.rooms?.[0]?.room_type_id ?? item?.room_types?.[0]?.room_type_id ?? null,
    // Guest comment (the booking-form "Comentários" box where guests type their
    // NIF). `note` is the only free-text guest field the Lodgify booking object
    // exposes (verified against live payloads); the rest are future-proofing.
    // NOT source_text — that is the channel label ("Direto", "*.lodgify.com").
    notes: firstStr(
      item?.note, item?.notes, item?.comment, item?.message,
      item?.guest?.comment, item?.guest?.notes, item?.guest?.message,
    ),
  };
}
