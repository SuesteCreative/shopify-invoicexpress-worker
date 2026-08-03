import { describe, it, expect } from "vitest";
import { firstNum, bookingAmountDue, bookingPaidAmount } from "./lodgify-amounts";

/**
 * Regression suite for the Overbuilding outage (2026-07-09 → 2026-08-03).
 *
 * With `moloni_partial_invoicing` on, the progressive path read `amount_paid`
 * directly and skipped anything at 0. OTA bookings (Airbnb / Booking.com) arrive
 * with `amount_paid: 0` AND `amount_due: 0` because the channel already collected
 * the money — so 14 of 16 settled bookings were skipped as "nothing paid yet" and
 * never invoiced. The fixtures below are the real prod rows.
 */

// Verbatim from lodgify_bookings, user_3Fqvs8MM3pQXW01pkQZY7iY61yy.
const OTA_SETTLED = { total_amount: 696, amount_paid: 0, amount_due: 0, source: "AirbnbIntegration" };
const OTA_SETTLED_BCOM = { total_amount: 720.52, amount_paid: 0, amount_due: 0, source: "BookingCom" };
const HALF_DEPOSIT = { total_amount: 1127, amount_paid: 563.5, amount_due: 563.5, source: "OH" };
const MANUAL_ODD = { total_amount: 360, amount_paid: 360, amount_due: 360, source: "Manual" };

describe("bookingPaidAmount", () => {
  it("treats a settled OTA booking as fully collected despite amount_paid=0", () => {
    // The regression: this returned 0 and the booking was skipped forever.
    expect(bookingPaidAmount(OTA_SETTLED)).toBe(696);
    expect(bookingPaidAmount(OTA_SETTLED_BCOM)).toBe(720.52);
  });

  it("bills only the deposit when a real balance is outstanding", () => {
    expect(bookingPaidAmount(HALF_DEPOSIT)).toBe(563.5);
  });

  it("uses the explicit amount_paid when Lodgify reports due==paid==total", () => {
    // Inconsistent Lodgify data; amount_paid is the only defensible signal.
    expect(bookingPaidAmount(MANUAL_ODD)).toBe(360);
  });

  it("returns 0 when nothing has been collected", () => {
    expect(bookingPaidAmount({ total_amount: 500, amount_paid: 0, amount_due: 500 })).toBe(0);
  });

  it("does not invent money for a zero-total booking", () => {
    expect(bookingPaidAmount({ total_amount: 0, amount_paid: 0, amount_due: 0 })).toBe(0);
  });

  it("agrees with the standard path: settled ⇒ billable", () => {
    // The two paths must never disagree about whether a booking is payable.
    for (const item of [OTA_SETTLED, OTA_SETTLED_BCOM]) {
      const due = bookingAmountDue(item);
      expect(due != null && due <= 0.01).toBe(true);   // standard path invoices
      expect(bookingPaidAmount(item)).toBeGreaterThan(0); // partial path must too
    }
  });

  it("rounds to cents", () => {
    expect(bookingPaidAmount({ total_amount: 10.005, amount_paid: 0, amount_due: 0 })).toBe(10.01);
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
