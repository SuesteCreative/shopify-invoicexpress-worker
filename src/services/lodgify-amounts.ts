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

// ── How a part-paid booking is billed ────────────────────────────────────────

/**
 * What a connection does with a booking that has been paid in part.
 *
 * `off` is every connection that never asked: a deposit is held, nothing is
 * issued, and the booking becomes billable when the money reaches the total.
 *
 * `instalment_invoices` bills each newly-paid amount as its own document
 * (`Order #N-<seq>`), so a 50/50 booking produces two Faturas/Recibos, each for
 * money already received. This is what Overbuilding runs.
 *
 * `invoice_plus_receipts` issues ONE Fatura for the whole stay — a Fatura states
 * a debt, not a payment, so issuing it while half the money is outstanding is
 * correct — and records each payment against it with a Recibo. The distinction
 * matters: a Fatura/Recibo asserts the money came in, which is why this mode
 * must not use one.
 */
export type PartialMode = "off" | "instalment_invoices" | "invoice_plus_receipts";

/**
 * Read the mode off a connection's destination config.
 *
 * `moloni_partial_invoicing` (the original boolean) keeps meaning what it always
 * meant, so no connection changes behaviour by being read through here.
 */
export function partialModeFrom(destinationConfig: Record<string, any> | undefined | null): PartialMode {
  const explicit = String(destinationConfig?.moloni_partial_mode ?? "").toLowerCase();
  if (explicit === "invoice_plus_receipts" || explicit === "instalment_invoices") return explicit;
  if (explicit === "off") return "off";
  return destinationConfig?.moloni_partial_invoicing ? "instalment_invoices" : "off";
}

/**
 * The settlement basis the source stamped on the order, if any.
 *
 * `LodgifySource` writes it as a note attribute so tag routing can match on it.
 * Reading it back here keeps one spelling of the attribute name in the codebase.
 */
export function orderSettlementBasis(
  order: { note_attributes?: Array<{ name?: string; value?: unknown }> | null } | null | undefined,
): SettlementBasis | null {
  const attrs = order?.note_attributes;
  if (!Array.isArray(attrs)) return null;
  for (const a of attrs) {
    if (String(a?.name ?? "").trim() !== "settlement") continue;
    const v = String(a?.value ?? "").trim();
    if (v === "instalment" || v === "paid_in_full" || v === "awaiting_payment" || v === "zero_total") return v;
  }
  return null;
}

/**
 * Must this sale be issued as a plain Fatura, whatever the routing rules say?
 *
 * Yes for a part-paid stay on `invoice_plus_receipts`: a Fatura/Recibo asserts
 * the money came in, and half of it has not. Returning "invoice" here OVERRIDES
 * tag routing deliberately.
 *
 * The rule used to live in a per-merchant routing rule, which was wrong twice
 * over. `matchTagRouting` returns the FIRST rule by created_at, so a merchant
 * with older `property_id:*` rules — Overbuilding has eight — would match those
 * and issue the Fatura/Recibo anyway; and a merchant put on the mode without
 * anyone remembering to add the rule gets the same wrong document silently.
 * Fiscal correctness cannot depend on the order rows were inserted in.
 */
export function forcedDocTypeForSettlement(
  order: { note_attributes?: Array<{ name?: string; value?: unknown }> | null } | null | undefined,
  destinationConfig: Record<string, any> | undefined | null,
): "invoice" | null {
  if (partialModeFrom(destinationConfig) !== "invoice_plus_receipts") return null;
  return orderSettlementBasis(order) === "instalment" ? "invoice" : null;
}

// ── The extras split ─────────────────────────────────────────────────────────

/**
 * Lodgify's own breakdown of a booking total, from the v2 booking.
 *
 * `fees` is the cleaning fee, `addons` the extras a guest picked. Both are
 * invoiced at their own VAT rate for a merchant who asked for the split, because
 * in Portugal accommodation is 6% (Lista I, verba 2.17 CIVA) and a cleaning fee
 * billed as its own service is not.
 *
 * `promotions` is negative and belongs to the STAY — a discount on the room, not
 * on the cleaning — which is why it appears in the sum check below and not in
 * the extras.
 */
export interface BookingSubtotals {
  stay: number | null;
  fees: number;
  addons: number;
  promotions: number;
  taxes: number;
  vat: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Read a `subtotals` object off a v2 booking payload. Null when there is none. */
export function parseBookingSubtotals(raw: unknown): BookingSubtotals | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown): number => firstNum(v) ?? 0;
  const fees = num(o.fees);
  const addons = num(o.addons);
  // A breakdown with nothing outside the stay is not worth acting on: the single
  // line it produces is the one we already make.
  if (round2(fees + addons) <= 0.01) return null;
  return {
    stay: firstNum(o.stay),
    fees: round2(fees),
    addons: round2(addons),
    promotions: round2(num(o.promotions)),
    taxes: round2(num(o.taxes)),
    vat: round2(num(o.vat)),
  };
}

/**
 * Split the total being billed into stay and extras, or null to keep one line.
 *
 * Refuses unless the breakdown ADDS UP to that total. A breakdown we cannot
 * reconcile is one we do not understand, and guessing would put a wrong tax base
 * on a fiscal document.
 *
 * The sum has to include `promotions`, which is negative: Roland Behrendt's stay
 * reads stay 1267,00 + promotions -63,35 + fees 115,00 = 1318,65. Checking only
 * stay + fees against the total would have refused to split precisely the
 * bookings that carry a discount.
 */
export function splitStayAndExtras(
  grossTotal: number,
  subtotals: BookingSubtotals | null,
  extrasRate: number,
): { stayGross: number; extrasGross: number } | null {
  if (!(extrasRate > 0) || !subtotals) return null;
  if (!Number.isFinite(grossTotal) || grossTotal <= 0) return null;

  const extrasGross = round2(subtotals.fees + subtotals.addons);
  // The discount lands on the accommodation, so the stay line is simply what is
  // left of the total — never `subtotals.stay`, which is the price before it.
  const stayGross = round2(grossTotal - extrasGross);
  if (extrasGross <= 0.01 || stayGross <= 0.01) return null;

  if (subtotals.stay != null) {
    const parts = round2(subtotals.stay + subtotals.promotions + extrasGross + subtotals.taxes + subtotals.vat);
    if (Math.abs(parts - round2(grossTotal)) > 0.02) return null;
  }
  return { stayGross, extrasGross };
}
