import { describe, it, expect } from "vitest";
import {
  firstNum,
  bookingAmountDue,
  bookingCollectedAmount,
  isBookingFullyCollected,
  bookingAwaitingPaymentMark,
  collectedSqlPredicate,
  awaitingPaymentMarkSqlPredicate,
  isOtaStayCollected,
  isOtaChannel,
  otaPolicyFrom,
  partialModeFrom,
  orderSettlementBasis,
  forcedDocTypeForSettlement,
} from "./lodgify-amounts";

/**
 * Regression suite for BOTH Overbuilding settlement incidents.
 *
 *   1. 2026-07-09 → 2026-08-03: `amount_paid` read raw, with no alerting. When
 *      the merchant stopped marking bookings paid, 14 of 16 went unbilled and
 *      nothing noticed for 26 days.
 *   2. 2026-08-03 → 2026-08-12: the fix for (1) read `amount_due == 0` as
 *      "fully paid". OTA bookings report a zero balance from the moment they are
 *      created, so 12 reservations for stays weeks away were billed on the spot,
 *      one of them already cancelled.
 *
 * The rule that survives both: money recorded in Lodgify is the trigger, and the
 * *absence* of money is never evidence of payment — it raises an alert instead.
 *
 * Amounts, channels and arrival dates are the real prod rows (the arrival date
 * is provable — incident 2 stamped it on the document). Departure dates are
 * plausible stay lengths, not measured.
 */

// Airbnb, invoice 1008791835 — booked 09-08, stay in September, nothing marked
// paid. The reservation the merchant put at the top of their complaint.
const OTA_UNMARKED = {
  total_amount: 1038, amount_paid: 0, amount_due: 0,
  source: "AirbnbIntegration", arrival: "2026-09-06", departure: "2026-09-13",
};

// The same booking after the merchant records the channel payout by hand.
const OTA_MARKED_PAID = { ...OTA_UNMARKED, amount_paid: 1038, amount_due: 0 };

// Booking.com, invoice 1005242329 — same shape, different channel.
const BCOM_UNMARKED = {
  total_amount: 900, amount_paid: 0, amount_due: 0,
  source: "BookingCom", arrival: "2026-08-29", departure: "2026-09-02",
};

// Airbnb, invoice 1005240679 — the 696 € row that incident 1's fix was built on.
// It was never "settled": on 2026-08-03 the guest had not even arrived.
const OTA_STAY_OVER = {
  total_amount: 696, amount_paid: 0, amount_due: 0,
  source: "AirbnbIntegration", arrival: "2026-07-20", departure: "2026-07-23",
};

// Direct booking (Lodgify collects) with a real 50% deposit — invoice 1005242305.
const DIRECT_DEPOSIT = {
  total_amount: 1127, amount_paid: 563.5, amount_due: 563.5,
  source: "OH", arrival: "2026-08-22", departure: "2026-08-29",
};

// Lodgify occasionally reports due == paid == total. Inconsistent; amount_paid
// is the only defensible reading.
const MANUAL_ODD = {
  total_amount: 360, amount_paid: 360, amount_due: 360,
  source: "Manual", arrival: "2026-07-30", departure: "2026-08-02",
};

describe("bookingCollectedAmount — incident 2: a zero balance is not a payment", () => {
  it("holds an OTA booking until the merchant records the payment", () => {
    // This is the bug the merchant reported: on 2026-08-12 both of these had a
    // document. Neither may have one.
    expect(bookingCollectedAmount(OTA_UNMARKED)).toEqual({ collected: 0, basis: "awaiting_payment" });
    expect(bookingCollectedAmount(BCOM_UNMARKED)).toEqual({ collected: 0, basis: "awaiting_payment" });
  });

  it("keeps holding it after the stay is over — a finished stay is not a payment", () => {
    // The tempting shortcut, and a wrong one: the guest can still have not paid,
    // and the merchant is the one who knows.
    expect(bookingCollectedAmount(OTA_STAY_OVER)).toEqual({ collected: 0, basis: "awaiting_payment" });
  });

  it("bills the moment the merchant marks it paid", () => {
    expect(bookingCollectedAmount(OTA_MARKED_PAID)).toEqual({ collected: 1038, basis: "paid_in_full" });
  });
});

describe("bookingCollectedAmount — direct bookings", () => {
  it("bills a recorded deposit as an instalment", () => {
    expect(bookingCollectedAmount(DIRECT_DEPOSIT)).toEqual({ collected: 563.5, basis: "instalment" });
  });

  it("bills the balance once it lands", () => {
    const settled = { ...DIRECT_DEPOSIT, amount_paid: 1127, amount_due: 0 };
    expect(bookingCollectedAmount(settled)).toEqual({ collected: 1127, basis: "paid_in_full" });
  });

  it("never bills more than the total when Lodgify over-reports amount_paid", () => {
    expect(bookingCollectedAmount({ ...DIRECT_DEPOSIT, amount_paid: 5000, amount_due: 12 }).collected).toBe(1127);
  });

  it("uses amount_paid when Lodgify reports due == paid == total", () => {
    // Paid covers the total, so this is settled — the basis has to say so even
    // though Lodgify left a full balance behind. It used to read "instalment",
    // which is what `blockerFor` refuses on, so admin recovery rejected bookings
    // that were paid in full. Real row: Overbuilding 22004722.
    expect(bookingCollectedAmount(MANUAL_ODD)).toEqual({ collected: 360, basis: "paid_in_full" });
  });

  it("calls a stale balance settled once the money covers the total", () => {
    // Overbuilding 21725295, live: the second 50 % landed, Lodgify never cleared
    // the balance. Two instalment documents already cover it (-1 and -2), and the
    // booking must not keep reading as part-paid.
    const staleBalance = { ...DIRECT_DEPOSIT, amount_paid: 1127, amount_due: 563.5 };
    expect(bookingCollectedAmount(staleBalance)).toEqual({ collected: 1127, basis: "paid_in_full" });
    expect(isBookingFullyCollected(staleBalance)).toBe(true);
  });

  it("holds an unpaid booking with an outstanding balance", () => {
    expect(bookingCollectedAmount({ total_amount: 500, amount_paid: 0, amount_due: 500 }))
      .toEqual({ collected: 0, basis: "awaiting_payment" });
  });

  it("invents nothing for a zero-total booking", () => {
    expect(bookingCollectedAmount({ total_amount: 0, amount_paid: 0, amount_due: 0 }))
      .toEqual({ collected: 0, basis: "zero_total" });
  });

  it("rounds to cents", () => {
    expect(bookingCollectedAmount({ total_amount: 10.01, amount_paid: 10.005, amount_due: 0 }).collected).toBe(10.01);
  });
});

describe("isBookingFullyCollected — the single-document gate", () => {
  it("refuses a partially-paid booking", () => {
    // The standard path issues ONE document for the whole total, so a 50%
    // deposit must not open the gate.
    expect(isBookingFullyCollected(DIRECT_DEPOSIT)).toBe(false);
  });

  it("accepts a fully-paid booking, direct or marked-paid OTA", () => {
    expect(isBookingFullyCollected(OTA_MARKED_PAID)).toBe(true);
    expect(isBookingFullyCollected({ ...DIRECT_DEPOSIT, amount_paid: 1127, amount_due: 0 })).toBe(true);
  });

  it("refuses everything the progressive path holds", () => {
    for (const item of [OTA_UNMARKED, BCOM_UNMARKED, OTA_STAY_OVER]) {
      expect(isBookingFullyCollected(item)).toBe(false);
    }
  });
});

/**
 * Incident 1 was not caused by the gate — it was caused by nobody noticing the
 * gate was closed. Making a manual step the trigger keeps that risk alive, so
 * the forgotten-booking detector is as much a part of the fix as the rule.
 */
describe("bookingAwaitingPaymentMark — the outage detector", () => {
  it("flags a finished stay with no payment recorded", () => {
    expect(bookingAwaitingPaymentMark(OTA_STAY_OVER, { today: "2026-08-12" })).toBe(true);
  });

  it("does not flag a stay that is still in the future", () => {
    expect(bookingAwaitingPaymentMark(OTA_UNMARKED, { today: "2026-08-12" })).toBe(false);
  });

  it("gives the payout and the merchant a few days' grace after check-out", () => {
    // Departure 2026-07-23 + 3 days grace → not flagged on the 25th, flagged on
    // the 26th. Marking lags check-out; paging on day one is noise.
    expect(bookingAwaitingPaymentMark(OTA_STAY_OVER, { today: "2026-07-25" })).toBe(false);
    expect(bookingAwaitingPaymentMark(OTA_STAY_OVER, { today: "2026-07-26" })).toBe(true);
  });

  it("never flags a booking that has money recorded", () => {
    expect(bookingAwaitingPaymentMark(MANUAL_ODD, { today: "2026-08-12" })).toBe(false);
    expect(bookingAwaitingPaymentMark(DIRECT_DEPOSIT, { today: "2026-12-31" })).toBe(false);
  });

  it("does not flag what it cannot date", () => {
    expect(bookingAwaitingPaymentMark({ total_amount: 300, amount_paid: 0, amount_due: 0 }, { today: "2026-08-12" })).toBe(false);
  });

  it("flags exactly what the invoice gate is holding, once the stay is over", () => {
    // The two must be complementary: anything held long-term is surfaced.
    const stale = { ...BCOM_UNMARKED, arrival: "2026-06-01", departure: "2026-06-05" };
    expect(isBookingFullyCollected(stale)).toBe(false);
    expect(bookingAwaitingPaymentMark(stale, { today: "2026-08-12" })).toBe(true);
  });
});

/**
 * The backlog alert asks the same questions in SQL, against the D1 mirror, so it
 * stays honest when the TypeScript path breaks. That duplication is deliberate —
 * and it is also how the alert came to count every future OTA booking as unbilled
 * revenue. Run the real predicates through real SQLite and assert they agree.
 */
describe("SQL predicates agree with the TypeScript rules", () => {
  const FIXTURES = [
    { id: "ota_unmarked", ...OTA_UNMARKED },
    { id: "bcom_unmarked", ...BCOM_UNMARKED },
    { id: "ota_marked_paid", ...OTA_MARKED_PAID },
    { id: "ota_stay_over", ...OTA_STAY_OVER },
    { id: "direct_deposit", ...DIRECT_DEPOSIT },
    { id: "manual_odd", ...MANUAL_ODD },
    { id: "zero_total", total_amount: 0, amount_paid: 0, amount_due: 0, arrival: "2026-01-01", departure: "2026-01-05" },
    { id: "unpaid", total_amount: 500, amount_paid: 0, amount_due: 500, arrival: "2026-01-01", departure: "2026-01-05" },
    { id: "no_dates", total_amount: 300, amount_paid: 0, amount_due: 0, arrival: null, departure: null },
  ];

  async function withDb(fn: (query: (predicate: string) => string[]) => void) {
    let DatabaseSync: any;
    try {
      // Specifier kept in a variable: this project typechecks against
      // @cloudflare/workers-types, which has no node:sqlite declarations, and a
      // literal import would fail `tsc` even though the test runs under Node.
      const nodeSqlite = "node:sqlite";
      ({ DatabaseSync } = await import(nodeSqlite));
    } catch {
      console.warn("node:sqlite unavailable; skipping SQL/TS agreement check");
      return;
    }
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE lodgify_bookings (
      id TEXT PRIMARY KEY, total_amount REAL, amount_paid REAL, amount_due REAL,
      arrival TEXT, departure TEXT
    )`);
    const ins = db.prepare(
      "INSERT INTO lodgify_bookings (id,total_amount,amount_paid,amount_due,arrival,departure) VALUES (?,?,?,?,?,?)"
    );
    for (const f of FIXTURES) {
      ins.run(f.id, f.total_amount, f.amount_paid, f.amount_due, f.arrival ?? null, f.departure ?? null);
    }
    fn((predicate) =>
      (db.prepare(`SELECT b.id FROM lodgify_bookings b WHERE ${predicate} ORDER BY b.id`).all() as Array<{ id: string }>)
        .map((r) => r.id));
    db.close();
  }

  it("collectedSqlPredicate matches bookingCollectedAmount", async () => {
    await withDb((query) => {
      const fromTs = FIXTURES
        .filter((f) => bookingCollectedAmount(f).collected > 0.01)
        .map((f) => f.id).sort();
      expect(query(collectedSqlPredicate())).toEqual(fromTs);
    });
  });

  it("awaitingPaymentMarkSqlPredicate matches bookingAwaitingPaymentMark", async () => {
    await withDb((query) => {
      // date('now') inside the predicate means "today" is whatever day the suite
      // runs, so ask the TS rule about the same day rather than a frozen one.
      const today = new Date().toISOString().slice(0, 10);
      const fromTs = FIXTURES
        .filter((f) => bookingAwaitingPaymentMark(f, { today, graceDays: 3 }))
        .map((f) => f.id).sort();
      expect(query(awaitingPaymentMarkSqlPredicate(3))).toEqual(fromTs);
    });
  });

  it("the two predicates never both match the same booking", async () => {
    await withDb((query) => {
      const billable = new Set(query(collectedSqlPredicate()));
      for (const id of query(awaitingPaymentMarkSqlPredicate(3))) {
        expect(billable.has(id), `${id} cannot be both billable and awaiting payment`).toBe(false);
      }
    });
  });
});

describe("bookingAmountDue", () => {
  it("prefers the explicit balance field", () => {
    expect(bookingAmountDue({ amount_due: 42.5, total_amount: 100, amount_paid: 10 })).toBe(42.5);
    expect(bookingAmountDue({ balance_due: 7, total_amount: 100 })).toBe(7);
  });

  it("falls back to total - paid when no balance field exists", () => {
    expect(bookingAmountDue({ total_amount: 100, amount_paid: 40 })).toBe(60);
  });

  it("returns null when the balance cannot be determined", () => {
    expect(bookingAmountDue({ total_amount: 100 })).toBeNull();
    expect(bookingAmountDue({})).toBeNull();
  });
});

describe("isOtaStayCollected — the opt-in that bills a stay nobody marked paid", () => {
  const airbnb = (over: Record<string, any> = {}) => ({
    source: "AirbnbIntegration",
    total_amount: 763.16,
    amount_paid: 0,
    amount_due: 0,
    arrival: "2026-07-10",
    departure: "2026-07-12",
    ...over,
  });
  const DEPARTURE = { on: "departure" } as const;

  it("is off unless the connection asked for it", () => {
    // The whole fleet's rule stays "recorded money or nothing".
    expect(isOtaStayCollected(airbnb(), undefined)).toBe(false);
    expect(otaPolicyFrom({})).toBeUndefined();
    expect(otaPolicyFrom({ lodgify_ota_invoice_on: "yes" })).toBeUndefined();
    expect(otaPolicyFrom({ lodgify_ota_invoice_on: "departure" })).toEqual({ on: "departure" });
  });

  it("bills an OTA stay that has already ended", () => {
    expect(isOtaStayCollected(airbnb(), DEPARTURE, "2026-08-14")).toBe(true);
  });

  it("holds a stay that has not ended yet — the August incident, in one line", () => {
    // Twelve future reservations were billed on creation when amount_due==0 was
    // read as payment. This rule waits for a date that has actually passed.
    expect(isOtaStayCollected(airbnb(), DEPARTURE, "2026-07-11")).toBe(false);
    expect(isOtaStayCollected(airbnb({ arrival: "2026-09-25", departure: "2026-09-27" }), DEPARTURE, "2026-08-14")).toBe(false);
  });

  it("bills on arrival when the connection says arrival", () => {
    expect(isOtaStayCollected(airbnb(), { on: "arrival" }, "2026-07-10")).toBe(true);
    expect(isOtaStayCollected(airbnb(), { on: "arrival" }, "2026-07-09")).toBe(false);
  });

  it("never touches a direct booking, whose money Lodgify does see", () => {
    expect(isOtaStayCollected(airbnb({ source: "Manual" }), DEPARTURE, "2026-08-14")).toBe(false);
    expect(isOtaStayCollected(airbnb({ source: "" }), DEPARTURE, "2026-08-14")).toBe(false);
  });

  it("stands back whenever Lodgify does know about money", () => {
    // A recorded payment or a real balance means the ordinary rule applies —
    // including the instalment path, which this must never pre-empt.
    expect(isOtaStayCollected(airbnb({ amount_paid: 100 }), DEPARTURE, "2026-08-14")).toBe(false);
    expect(isOtaStayCollected(airbnb({ amount_due: 100 }), DEPARTURE, "2026-08-14")).toBe(false);
  });

  it("refuses a zero-total booking and one with no dates", () => {
    expect(isOtaStayCollected(airbnb({ total_amount: 0 }), DEPARTURE, "2026-08-14")).toBe(false);
    expect(isOtaStayCollected(airbnb({ arrival: "", departure: "" }), DEPARTURE, "2026-08-14")).toBe(false);
  });

  it("recognises the channels that collect on the host's behalf", () => {
    expect(isOtaChannel("AirbnbIntegration")).toBe(true);
    expect(isOtaChannel("BookingCom")).toBe(true);
    expect(isOtaChannel("Booking.com")).toBe(true);
    expect(isOtaChannel("Manual")).toBe(false);
    expect(isOtaChannel("")).toBe(false);
  });

  it("keeps isBookingFullyCollected honest with and without the policy", () => {
    expect(isBookingFullyCollected(airbnb())).toBe(false);
    expect(isBookingFullyCollected(airbnb(), DEPARTURE)).toBe(true);
  });
});

describe("firstNum", () => {
  it("returns the first finite number and skips nullish values", () => {
    expect(firstNum(null, undefined, 5, 9)).toBe(5);
    expect(firstNum(undefined, null)).toBeNull();
  });

  it("unwraps { amount } objects", () => {
    expect(firstNum({ amount: 12.5 })).toBe(12.5);
  });

  it("treats 0 as a real value, not absence", () => {
    expect(firstNum(0, 99)).toBe(0);
  });
});

/**
 * How a connection says what to do with a deposit.
 *
 * The boolean came first and is live on Overbuilding, so reading it through the
 * new function must not change that connection's behaviour by a hair.
 */
describe("partialModeFrom", () => {
  it("is off when nothing is configured", () => {
    expect(partialModeFrom(undefined)).toBe("off");
    expect(partialModeFrom({})).toBe("off");
    expect(partialModeFrom({ moloni_partial_invoicing: false })).toBe("off");
  });

  it("keeps the original boolean meaning instalment invoices", () => {
    expect(partialModeFrom({ moloni_partial_invoicing: true })).toBe("instalment_invoices");
    expect(partialModeFrom({ moloni_partial_invoicing: 1 })).toBe("instalment_invoices");
  });

  it("reads the explicit mode", () => {
    expect(partialModeFrom({ moloni_partial_mode: "invoice_plus_receipts" })).toBe("invoice_plus_receipts");
    expect(partialModeFrom({ moloni_partial_mode: "instalment_invoices" })).toBe("instalment_invoices");
  });

  it("lets the explicit mode turn the old boolean off", () => {
    // Otherwise a connection could not be moved off instalments without
    // deleting a key, and "off" would be unsayable.
    expect(partialModeFrom({ moloni_partial_invoicing: true, moloni_partial_mode: "off" })).toBe("off");
  });

  it("ignores a mode it does not know", () => {
    expect(partialModeFrom({ moloni_partial_mode: "whatever" })).toBe("off");
    expect(partialModeFrom({ moloni_partial_mode: "whatever", moloni_partial_invoicing: true }))
      .toBe("instalment_invoices");
  });
});

/**
 * Which document a part-paid stay gets, and why it is decided in code.
 *
 * This started life as a per-merchant tag routing rule and had to move: rules
 * are matched FIRST-created-wins, so Overbuilding's eight older `property_id:*`
 * rules would have won and issued a Fatura/Recibo — the document that asserts
 * the money arrived — for a stay with half of it outstanding.
 */
describe("forcedDocTypeForSettlement", () => {
  const order = (basis: string) => ({ note_attributes: [{ name: "property_id", value: "686582" }, { name: "settlement", value: basis }] });
  const MODE = { moloni_partial_mode: "invoice_plus_receipts" };

  it("forces a Fatura for a part-paid stay on the mode", () => {
    expect(forcedDocTypeForSettlement(order("instalment"), MODE)).toBe("invoice");
  });

  it("leaves every other settlement alone", () => {
    expect(forcedDocTypeForSettlement(order("paid_in_full"), MODE)).toBeNull();
    expect(forcedDocTypeForSettlement(order("awaiting_payment"), MODE)).toBeNull();
    expect(forcedDocTypeForSettlement(order("zero_total"), MODE)).toBeNull();
  });

  it("does nothing for a connection that is not on the mode", () => {
    // Overbuilding today: instalments, and its own routing rules decide.
    expect(forcedDocTypeForSettlement(order("instalment"), { moloni_partial_invoicing: true })).toBeNull();
    expect(forcedDocTypeForSettlement(order("instalment"), {})).toBeNull();
    expect(forcedDocTypeForSettlement(order("instalment"), undefined)).toBeNull();
  });

  it("does nothing when the source stamped no settlement", () => {
    expect(forcedDocTypeForSettlement({ note_attributes: [{ name: "source", value: "manual" }] }, MODE)).toBeNull();
    expect(forcedDocTypeForSettlement({ note_attributes: null }, MODE)).toBeNull();
    expect(forcedDocTypeForSettlement(undefined, MODE)).toBeNull();
  });
});

describe("orderSettlementBasis", () => {
  it("reads the attribute the source stamps", () => {
    expect(orderSettlementBasis({ note_attributes: [{ name: "settlement", value: "instalment" }] })).toBe("instalment");
  });

  it("ignores a value that is not a settlement basis", () => {
    // Never guess from a stray attribute — a wrong basis picks a wrong document.
    expect(orderSettlementBasis({ note_attributes: [{ name: "settlement", value: "partial" }] })).toBeNull();
  });

  it("is not confused by other attributes", () => {
    expect(orderSettlementBasis({ note_attributes: [{ name: "nif", value: "instalment" }] })).toBeNull();
  });
});
