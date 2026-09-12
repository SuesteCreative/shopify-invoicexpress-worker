import { describe, it, expect } from "vitest";
import { seatPoolOf, INCLUDED_SEATS, seatStatusOf, SEAT_PRICE_CENTS } from "./price-catalogue";

/**
 * Seats are capacity, not people.
 *
 * The account buys a pool, fills it in order, and a member who leaves frees
 * their seat for the next invite at no charge. Every question worth asking is
 * about the pool; the per-invite columns migration 0039 used to write
 * (`seat_paid_at` and friends) have been dead since 0040.
 */
describe("the seat pool", () => {
    it("includes one seat with the account", () => {
        expect(seatPoolOf(0, 0)).toMatchObject({ paid: 0, capacity: INCLUDED_SEATS, occupied: 0, free: 1 });
    });

    it("counts a bought seat as capacity, not as a person", () => {
        expect(seatPoolOf(2, 0)).toMatchObject({ capacity: 3, free: 3 });
        expect(seatPoolOf(2, 3)).toMatchObject({ capacity: 3, occupied: 3, free: 0 });
    });

    it("frees the seat when a member goes, without refunding it", () => {
        // Two bought, three filled, one leaves: capacity is untouched.
        expect(seatPoolOf(2, 2).free).toBe(1);
    });

    it("never reports negative room when the pool is over-occupied", () => {
        // Seats are not taken away from someone already sitting in one, so an
        // account can hold more members than capacity after a downgrade.
        expect(seatPoolOf(0, 5)).toMatchObject({ capacity: 1, occupied: 5, free: 0 });
    });
});

describe("the seat price", () => {
    const ok = { active: true, unit_amount: SEAT_PRICE_CENTS, recurring: null };

    it("passes a live one-off price at 1,50 €", () => {
        expect(seatStatusOf(ok)).toBe("ok");
    });

    it("refuses a recurring price, which Checkout would reject at the till", () => {
        expect(seatStatusOf({ ...ok, recurring: { interval: "month" } })).toBe("recurring");
    });

    it("notices the price gone, archived, or at the wrong amount", () => {
        expect(seatStatusOf(null)).toBe("missing");
        expect(seatStatusOf({ ...ok, active: false })).toBe("archived");
        expect(seatStatusOf({ ...ok, unit_amount: 185 })).toBe("wrong_amount");
    });
});
