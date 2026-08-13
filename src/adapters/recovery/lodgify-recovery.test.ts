import { describe, it, expect } from "vitest";
import { blockerFor } from "./lodgify-recovery";

/**
 * These are the rules that decide whether a merchant gets a fiscal document.
 *
 * They matter more here than anywhere else in the recovery layer: supplying a
 * `_preloaded_booking` makes LodgifySource skip its OWN settlement gate, on the
 * grounds that the caller already applied it. If this function is wrong, nothing
 * downstream catches it — and both naive readings of Lodgify's payment fields
 * have already shipped and billed the wrong thing.
 */

const booked = (over: Record<string, unknown> = {}) => ({
  status: "Booked",
  total_amount: 100,
  amount_paid: 100,
  amount_due: 0,
  ...over,
});

describe("blockerFor", () => {
  it("allows a booking paid in full", () => {
    expect(blockerFor(booked())).toBeNull();
  });

  it("holds a booking with no payment recorded", () => {
    // amount_due = 0 is NOT a payment signal: it reads 0 for the whole life of
    // an OTA booking, from the minute it is created. Only recorded money counts.
    const b = blockerFor(booked({ amount_paid: 0, amount_due: 0 }));
    expect(b).toMatch(/sem pagamento registado/);
  });

  it("leaves a part-paid booking to the instalment path", () => {
    // Billing one document for the whole total here would invoice money nobody
    // has received; the poll issues one document per instalment instead.
    const b = blockerFor(booked({ amount_paid: 40, amount_due: 60 }));
    expect(b).toMatch(/liquidação parcial/);
    expect(b).toContain("40.00");
  });

  it("refuses a cancelled or declined booking", () => {
    for (const status of ["Declined", "Cancelled", "canceled"]) {
      expect(blockerFor(booked({ status }))).toMatch(/reserva/i);
    }
  });

  it("refuses a cancelled booking even when it was paid", () => {
    // Order matters: the status check runs before the settlement check, so a
    // paid-then-cancelled stay is never billed.
    expect(blockerFor(booked({ status: "Declined", amount_paid: 100 }))).toMatch(/reserva/i);
  });

  it("refuses a booking with nothing to bill", () => {
    expect(blockerFor(booked({ total_amount: 0, amount_paid: 0 }))).toMatch(/sem valor/);
  });

  it("treats a missing balance as a part payment, not a full one", () => {
    // With no amount_due to confirm the balance is clear, what came in is only
    // what came in. Assuming otherwise is how future stays got billed.
    const b = blockerFor({ status: "Booked", total_amount: 100, amount_paid: 40 });
    expect(b).toMatch(/liquidação parcial/);
  });
});
