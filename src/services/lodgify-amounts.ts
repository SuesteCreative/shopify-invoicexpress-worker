/**
 * Money helpers for Lodgify booking items.
 *
 * Extracted from src/index.ts so the settlement rules can be unit-tested in
 * isolation — they decide whether a merchant issues a fiscal document, and have
 * now been wrong in both directions (see the history note on
 * `bookingCollectedAmount`), so they are worth pinning down with tests.
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

const cents = (n: number): number => Math.round(n * 100) / 100;

/** YYYY-MM-DD prefix of a date-ish value, or "" when there isn't one. */
function ymd(input: unknown): string {
  const m = String(input ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

// Outstanding balance in Lodgify for a booking item, or null if undeterminable.
//
// READ THIS BEFORE USING IT AS A PAYMENT SIGNAL: `amount_due === 0` does NOT
// mean "paid". For OTA reservations (Airbnb / Booking.com) the guest's money
// never passes through Lodgify, so the balance is reported as 0 for the entire
// life of the booking — the minute it is created, long before the channel pays
// out, and after it is cancelled. Use `bookingCollectedAmount`, which knows the
// difference between "nothing owed" and "something received".
export function bookingAmountDue(item: any): number | null {
  const due = firstNum(item?.amount_due, item?.balance_due);
  if (due != null) return cents(due);
  const total = firstNum(item?.total_amount, item?.total);
  const paid = firstNum(item?.amount_paid, item?.total_paid);
  if (total != null && paid != null) return cents(total - paid);
  return null;
}

export type SettlementBasis =
  | "paid_in_full"       // Lodgify records money and no remaining balance
  | "instalment"         // Lodgify records a partial payment, balance outstanding
  | "awaiting_payment"   // nothing recorded — HOLD until the merchant marks it
  | "zero_total";        // nothing to bill

export interface Settlement {
  /** Gross amount Lodgify says has been collected, in the booking's currency. */
  collected: number;
  /** Why. Carried into logs and incidents so a hold is explainable. */
  basis: SettlementBasis;
}

/**
 * How much of this booking has actually been collected.
 *
 * The ONLY payment signal is `amount_paid` — what the merchant has recorded as
 * received in the Lodgify backoffice. For direct bookings Lodgify captures that
 * itself; for OTA stays (Airbnb / Booking.com) the money never passes through
 * Lodgify and the merchant marks the booking paid by hand once the channel pays
 * out. Either way, money recorded is the trigger, and nothing else is.
 *
 * `amount_due` is NOT a payment signal and must never be read as one. It reads 0
 * for the entire life of an OTA booking — the minute it is created, before any
 * payout, and after it is cancelled. It only refines a payment that has already
 * been recorded: no balance left ⇒ what came in was the whole total.
 *
 * Both naive readings of these fields have already shipped and both were wrong:
 *
 *   1. 2026-07-09 → 2026-08-03: `amount_paid` read raw, with no alerting. When
 *      the merchant stopped marking bookings paid, 14 of 16 went unbilled and
 *      NOTHING noticed for 26 days. The bug there was the silence, not the
 *      field — hence `bookingAwaitingPaymentMark`, which now watches for it.
 *   2. 2026-08-03 → 2026-08-12: the fix for (1) read `amount_due === 0` as
 *      "fully paid", and billed 12 reservations for stays weeks away — one of
 *      them already cancelled. This is what the merchant complained about.
 *
 * So: hold until there is money. Never infer payment from its absence.
 */
export function bookingCollectedAmount(item: any): Settlement {
  const total = cents(firstNum(item?.total_amount, item?.total) ?? 0);
  if (total <= 0) return { collected: 0, basis: "zero_total" };

  const paid = cents(firstNum(item?.amount_paid, item?.total_paid) ?? 0);
  if (paid <= 0.01) return { collected: 0, basis: "awaiting_payment" };

  const due = bookingAmountDue(item);
  const collected = due != null && due <= 0.01 ? total : Math.min(paid, total);

  // The basis says whether the money COVERS the total. That is a fact about
  // `collected` — never about Lodgify's balance field, which is stale often
  // enough that reading it here mislabelled fully-paid bookings as instalments:
  // Overbuilding 21725295 reports total 1127, paid 1127, due 563,50, and 22004722
  // reports total 360, paid 360, due 360. `blockerFor` branches on this, so admin
  // recovery refused bookings that were paid in full, quoting a part-payment that
  // did not exist. `collected` itself is unchanged — only the label it carries.
  return { collected, basis: collected + 0.01 >= total ? "paid_in_full" : "instalment" };
}

/**
 * Is the booking collected in full — the gate for issuing ONE document for the
 * whole total (the non-progressive path).
 */
export function isBookingFullyCollected(item: any, policy?: OtaPolicy): boolean {
  const total = cents(firstNum(item?.total_amount, item?.total) ?? 0);
  if (total <= 0) return false;
  if (bookingCollectedAmount(item).collected + 0.01 >= total) return true;
  return isOtaStayCollected(item, policy);
}

/**
 * Per-connection escape hatch for merchants whose money never reaches Lodgify.
 *
 * `on` names the moment an OTA stay counts as collected. Absent = the default
 * everywhere: nothing but recorded money bills anything.
 */
export interface OtaPolicy {
  on: "departure" | "arrival";
}

/**
 * Read the policy off a connection's destination config, so every gate reaches
 * the same verdict from the same stored value.
 *
 * `lodgify_ota_invoice_on`: "departure" | "arrival". Anything else — including
 * absent, which is every connection but the one that asked — means off.
 */
export function otaPolicyFrom(destinationConfig: Record<string, any> | undefined | null): OtaPolicy | undefined {
  const on = String(destinationConfig?.lodgify_ota_invoice_on ?? "").toLowerCase();
  if (on === "departure" || on === "arrival") return { on };
  return undefined;
}

/** Lodgify `source` values where the channel collects the money, not the host. */
const OTA_SOURCES = ["airbnb", "bookingcom", "booking.com", "expedia", "vrbo", "homeaway", "tripadvisor"];

export function isOtaChannel(source: unknown): boolean {
  // Strip the SAME characters on both sides — Lodgify writes "BookingCom" on a
  // booking and "Booking.com" in places a human typed it, and a comparison that
  // keeps the dot on one side only matches neither reliably. The SQL twin
  // (`otaStayCollectedSqlPredicate`) strips the same set.
  const norm = (v: string) => v.toLowerCase().replace(/[\s_.-]/g, "");
  const s = norm(String(source ?? ""));
  return OTA_SOURCES.some((o) => s.includes(norm(o)));
}

/**
 * Treat an OTA stay as collected once it has happened.
 *
 * OFF BY DEFAULT, and it must stay that way. The rule everywhere else is that
 * recorded money is the only trigger, precisely because `amount_due == 0` reads
 * identically on a booking created five minutes ago, one the channel has paid
 * out, and one that was cancelled — reading it as "paid" is what billed twelve
 * future stays for Overbuilding in August.
 *
 * What makes this safe enough to offer at all is that it does not read a payment
 * signal: it waits for the stay itself, which is a fact with a date. A host who
 * knows the channel always pays out (Airbnb/Booking.com collect at booking) can
 * opt in and stop marking every reservation by hand. The trade the merchant is
 * making, and must be told they are making: a stay that happened but was never
 * paid for will be invoiced anyway.
 *
 * Only applies where money is genuinely absent (paid 0 AND due 0 — the OTA
 * signature). A booking with a real balance is a direct booking and keeps the
 * ordinary rule.
 */
export function isOtaStayCollected(item: any, policy?: OtaPolicy, today?: string): boolean {
  if (!policy) return false;
  if (!isOtaChannel(item?.source)) return false;

  const total = cents(firstNum(item?.total_amount, item?.total) ?? 0);
  if (total <= 0) return false;

  const paid = cents(firstNum(item?.amount_paid, item?.total_paid) ?? 0);
  const due = bookingAmountDue(item);
  // Any money recorded, or any outstanding balance, means Lodgify does know
  // about this booking's money — leave it to the ordinary rule.
  if (paid > 0.01) return false;
  if (due != null && due > 0.01) return false;

  const trigger = policy.on === "arrival" ? ymd(item?.arrival) : (ymd(item?.departure) || ymd(item?.arrival));
  if (!trigger) return false;
  return trigger <= (today ?? new Date().toISOString().slice(0, 10));
}

/** SQL counterpart of `isOtaStayCollected`, for the mirror's columns (alias `b`). */
export function otaStayCollectedSqlPredicate(policy?: OtaPolicy): string | null {
  if (!policy) return null;
  const dateCol = policy.on === "arrival"
    ? `NULLIF(b.arrival, '')`
    : `COALESCE(NULLIF(b.departure, ''), NULLIF(b.arrival, ''))`;
  const sources = OTA_SOURCES.map((s) => `'%${s.replace(/[\s_.-]/g, "")}%'`);
  const sourceMatch = sources.map((s) => `lower(replace(replace(COALESCE(b.source,''),' ',''),'.','')) LIKE ${s}`).join(" OR ");
  return `(
       COALESCE(b.total_amount, 0) > 0
       AND COALESCE(b.amount_paid, 0) <= 0.01
       AND COALESCE(b.amount_due, 0) <= 0.01
       AND (${sourceMatch})
       AND ${dateCol} IS NOT NULL
       AND ${dateCol} <= date('now')
     )`;
}

/**
 * Has this booking's stay ended with no payment ever recorded?
 *
 * The counterweight to making a manual step the trigger: if the merchant forgets
 * to mark a booking paid, it is simply never invoiced, and that is exactly the
 * shape of the 26-day outage. Nothing here bills anything — a completed stay is
 * not evidence of payment. It only says "this one looks forgotten", so the
 * backlog alert can name it while the merchant can still act on it.
 *
 * `graceDays` keeps a stay that ended yesterday out of the count, since the
 * payout and the marking both lag check-out.
 */
export function bookingAwaitingPaymentMark(
  item: any,
  opts: { today: string; graceDays?: number },
): boolean {
  if (bookingCollectedAmount(item).basis !== "awaiting_payment") return false;
  const departure = ymd(item?.departure) || ymd(item?.arrival);
  if (!departure) return false;
  const cutoff = new Date(`${opts.today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - (opts.graceDays ?? 3));
  return departure <= cutoff.toISOString().slice(0, 10);
}

/**
 * SQL fragment matching `bookingCollectedAmount(...).collected > 0` against the
 * `lodgify_bookings` mirror, for the columns of alias `b`.
 *
 * The backlog alert asks "is there money recorded that we never billed?" in SQL,
 * against the mirror, deliberately bypassing the TypeScript path so it stays
 * honest when that path breaks. The cost is two expressions of one rule, which
 * is how the alert came to count every future OTA booking as unbilled revenue.
 * Keep this in lockstep with the function above; the tests assert the two agree
 * row for row.
 */
export function collectedSqlPredicate(): string {
  return `(COALESCE(b.total_amount, 0) > 0 AND COALESCE(b.amount_paid, 0) > 0.01)`;
}

/**
 * SQL counterpart of `bookingAwaitingPaymentMark` — stays that ended without a
 * payment ever being recorded. Not a backlog of lost invoices: a backlog of
 * bookings the merchant probably forgot to mark as paid in Lodgify.
 */
export function awaitingPaymentMarkSqlPredicate(graceDays = 3): string {
  const days = Number.isFinite(graceDays) ? Math.max(0, Math.trunc(graceDays)) : 3;
  return `(
       COALESCE(b.total_amount, 0) > 0
       AND COALESCE(b.amount_paid, 0) <= 0.01
       AND COALESCE(NULLIF(b.departure, ''), NULLIF(b.arrival, '')) IS NOT NULL
       AND COALESCE(NULLIF(b.departure, ''), NULLIF(b.arrival, '')) <= date('now', '-${days} days')
     )`;
}
