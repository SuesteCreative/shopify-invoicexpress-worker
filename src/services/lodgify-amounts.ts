/**
 * Money helpers for Lodgify booking items.
 *
 * Extracted from src/index.ts so the settlement rules can be unit-tested in
 * isolation — they encode a Lodgify data quirk that silently stopped a
 * merchant's invoicing for 26 days, and are worth pinning down with tests.
 */

/** First finite number among vals (unwrapping `{ amount }` objects), else null. */
export function firstNum(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (v == null) continue;
    const n = typeof v === "object" && v !== null && "amount" in (v as any)
      ? Number((v as any).amount)
      : Number(v as any);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// Outstanding balance in Lodgify for a v2 booking item, or null if undeterminable.
// Policy (confirmed with merchant): invoice a booking only once it is PAID in
// Lodgify — i.e. amount_due≈0. That covers both direct payments captured through
// Lodgify AND OTA (Booking.com/Airbnb) stays, which arrive already settled.
// Bookings with a positive balance are skipped and re-evaluated on every poll
// (never marked processed), so they invoice automatically on the poll after
// payment lands.
export function bookingAmountDue(item: any): number | null {
  const due = firstNum(item?.amount_due, item?.balance_due);
  if (due != null) return Math.round(due * 100) / 100;
  const total = firstNum(item?.total_amount, item?.total);
  const paid = firstNum(item?.amount_paid, item?.total_paid);
  if (total != null && paid != null) return Math.round((total - paid) * 100) / 100;
  return null;
}

/**
 * Gross amount already collected for a booking, in the booking's currency.
 *
 * `amount_paid` on its own is NOT a payment signal. For OTA reservations
 * (Airbnb / Booking.com) the channel collects the guest's money, so Lodgify
 * reports `amount_paid: 0` AND `amount_due: 0` on a booking that is fully
 * settled. The standard path reads settlement off `amount_due` via
 * `bookingAmountDue`; the progressive path MUST agree with it, otherwise every
 * OTA booking is skipped as "nothing paid yet" — which is what silently stopped
 * Overbuilding's invoicing for 26 days (14 of 16 bookings, all OTA).
 *
 * Settled (due ≈ 0) ⇒ the full total was collected, whatever `amount_paid` says.
 * Otherwise use the explicit `amount_paid` — a genuine instalment/deposit.
 */
export function bookingPaidAmount(item: any): number {
  const total = firstNum(item?.total_amount, item?.total) ?? 0;
  const paid = firstNum(item?.amount_paid, item?.total_paid) ?? 0;
  const due = bookingAmountDue(item);
  if (due != null && due <= 0.01 && total > 0) return Math.round(total * 100) / 100;
  return Math.round(paid * 100) / 100;
}
