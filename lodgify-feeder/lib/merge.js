/**
 * Merge a Lodgify v1 booking DETAIL into a v1 LIST item.
 *
 * Why this exists: the list endpoint carries the money and the dates but a thin
 * guest; the per-booking detail carries the postal address and the `note` field
 * where a Portuguese guest types their NIF. The Worker used to fetch that detail
 * itself, but Lodgify blocks its egress, so the fetch moved out here and the
 * result has to travel back inside the item.
 *
 * Rules, in order of how much damage breaking them does:
 *   1. Never touch money or status. The Worker decides what is billable, from
 *      the list item's own `amount_paid` / `amount_due` / `total_amount`.
 *   2. Never overwrite a value the item already has — the list is the authority
 *      on everything it reports.
 *   3. Pure: no I/O, no mutation of the inputs, same output for same input.
 */

/** First non-empty trimmed string among vals, else null. */
function firstStr(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s.length > 0) return s;
  }
  return null;
}

/** True when a value is absent or an empty/whitespace string. */
function isBlank(v) {
  return v == null || String(v).trim().length === 0;
}

/**
 * @param {Record<string, any>} item   raw v1 list item
 * @param {Record<string, any>|null} detail raw v1 `/v1/reservation/booking/{id}` body
 * @returns {Record<string, any>} a new item; `item` and `detail` are untouched
 */
export function mergeDetailIntoItem(item, detail) {
  if (!item || typeof item !== "object") throw new TypeError("mergeDetailIntoItem: item must be an object");
  if (!detail || typeof detail !== "object") return item;

  const dg = detail.guest && typeof detail.guest === "object" ? detail.guest : {};
  const ig = item.guest && typeof item.guest === "object" ? item.guest : {};

  // The NIF path. `note` is the booking-form "Comentários" box, the only free
  // text a guest can reach; the Worker scans it for a 9-digit PT NIF. NOT
  // source_text — that is the channel label ("Direto", "*.lodgify.com").
  const note = firstStr(item.note, detail.note, detail.comment, detail.message);

  // Lodgify reports phones as a scalar on some payloads and an array on others.
  // The Worker reads `phone` / `phone_number` only, so flatten here or lose it.
  const phone = firstStr(
    ig.phone, ig.phone_number,
    dg.phone, dg.phone_number,
    Array.isArray(dg.phone_numbers) ? dg.phone_numbers[0] : null,
  );

  return {
    ...item,
    ...(note == null ? {} : { note }),
    guest: {
      ...ig,
      name: firstStr(ig.name, ig.guest_name?.full_name, dg.name, dg.guest_name?.full_name) ?? ig.name ?? null,
      email: firstStr(ig.email, dg.email) ?? ig.email ?? null,
      country_code: firstStr(ig.country_code, dg.country_code) ?? ig.country_code ?? null,
      ...(phone == null ? {} : { phone }),
      // v1's own field names, read back by toPreloadedFromItem in the Worker.
      ...(isBlank(ig.street_address1) && !isBlank(dg.street_address1) ? { street_address1: dg.street_address1 } : {}),
      ...(isBlank(ig.street_address2) && !isBlank(dg.street_address2) ? { street_address2: dg.street_address2 } : {}),
      ...(isBlank(ig.city) && !isBlank(dg.city) ? { city: dg.city } : {}),
      ...(isBlank(ig.postal_code) && !isBlank(dg.postal_code) ? { postal_code: dg.postal_code } : {}),
      ...(isBlank(ig.state) && !isBlank(dg.state) ? { state: dg.state } : {}),
    },
    // Tells the Worker not to make its own (guaranteed-blocked) detail call.
    // A marker of "someone already tried", never a claim that data was found.
    _enriched: true,
  };
}
