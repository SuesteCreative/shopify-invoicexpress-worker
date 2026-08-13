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
    currency_code: item?.currency_code ?? "EUR",
    guest: {
      name: item?.guest?.name ?? item?.guest?.guest_name?.full_name ?? null,
      email: item?.guest?.email ?? null,
      country_code: item?.guest?.country_code ?? null,
      phone: item?.guest?.phone ?? item?.guest?.phone_number ?? null,
    },
    arrival: ymd(item?.arrival ?? item?.date_arrival),
    departure: ymd(item?.departure ?? item?.date_departure),
    property_id: item?.property_id ?? null,
    source: item?.source ?? null,
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
