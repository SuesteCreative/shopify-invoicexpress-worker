import { describe, it, expect } from "vitest";
import { LEGACY_MONTHLY_SUNSET, currentPriceCents, sunsetAt, tierOf, resolveTier } from "./billing-legacy";

const price = (cents: number, interval: string, count = 1) => ({
    unit_amount: cents,
    recurring: { interval, interval_count: count },
});

describe("which price a client is on", () => {
    it("reads the two ladders", () => {
        expect(tierOf(price(500, "month"))).toBe("legacy");
        expect(tierOf(price(750, "month"))).toBe("current");
        expect(tierOf(price(5000, "year"))).toBe("legacy");
        expect(tierOf(price(7500, "year"))).toBe("current");
    });

    it("says unknown rather than guessing", () => {
        expect(tierOf(null)).toBe("unknown");
        expect(tierOf({ unit_amount: 500, recurring: null })).toBe("unknown");
        expect(tierOf(price(500, "week"))).toBe("unknown");
        // A price with no amount is metered or broken; either way it is not a
        // ladder rung, and calling it legacy would hand out a free pass.
        expect(tierOf({ unit_amount: null, recurring: { interval: "month" } })).toBe("unknown");
    });
});

describe("when the old price ends", () => {
    it("lets an annual run to the end of what was paid", () => {
        expect(sunsetAt({ tier: "legacy", interval: "year", currentPeriodEnd: "2027-03-05T08:57:23.000Z" }))
            .toBe("2027-03-05T08:57:23.000Z");
    });

    it("cuts a monthly on the fixed date", () => {
        expect(sunsetAt({ tier: "legacy", interval: "month", currentPeriodEnd: "2026-09-30T16:45:59.000Z" }))
            .toBe(LEGACY_MONTHLY_SUNSET);
    });

    it("never cuts a monthly inside a period already paid for", () => {
        expect(sunsetAt({ tier: "legacy", interval: "month", currentPeriodEnd: "2027-01-20T10:00:00.000Z" }))
            .toBe("2027-01-20T10:00:00.000Z");
    });

    it("has nothing to say about a current price", () => {
        expect(sunsetAt({ tier: "current", interval: "year", currentPeriodEnd: "2027-03-05T08:57:23.000Z" })).toBeNull();
    });
});

describe("what it costs afterwards", () => {
    it("names the plan that replaces it", () => {
        expect(currentPriceCents("month")).toBe(750);
        expect(currentPriceCents("year")).toBe(7500);
        expect(currentPriceCents("week")).toBeNull();
    });
});

describe("resolveTier", () => {
    it("lets an operator override the price, in both directions", () => {
        // The point of the toggle: a price id that is really a lookup key never
        // resolves, and a subscription added by hand may carry no price at all.
        expect(resolveTier({ override: 1, price: { unit_amount: 750, recurring: { interval: "month" } } }))
            .toEqual({ tier: "legacy", source: "override", legacy: true });
        expect(resolveTier({ override: 0, price: { unit_amount: 500, recurring: { interval: "month" } } }))
            .toEqual({ tier: "current", source: "override", legacy: false });
    });

    it("reads the price when nobody has answered", () => {
        expect(resolveTier({ override: null, price: { unit_amount: 500, recurring: { interval: "month" } } }))
            .toEqual({ tier: "legacy", source: "price", legacy: true });
        expect(resolveTier({ price: { unit_amount: 7500, recurring: { interval: "year" } } }))
            .toEqual({ tier: "current", source: "price", legacy: false });
    });

    it("falls back to what was actually charged", () => {
        // Gross, and both shapes of it: the legacy prices predate the tax rate,
        // so 5 € and 6,15 € are the same plan.
        for (const gross of [500, 615, 5000, 6150]) {
            expect(resolveTier({ paidGrossCents: gross }).legacy).toBe(true);
        }
        for (const gross of [923, 9225]) {
            expect(resolveTier({ paidGrossCents: gross }).legacy).toBe(false);
        }
    });

    it("ignores a seat, which says nothing about the plan", () => {
        // 1,50 € + 23 %. Alliance's only failed invoice was exactly this.
        expect(resolveTier({ paidGrossCents: 185 }))
            .toEqual({ tier: "unknown", source: "unknown", legacy: false });
    });

    it("prefers the price over the invoice", () => {
        expect(resolveTier({
            price: { unit_amount: 750, recurring: { interval: "month" } },
            paidGrossCents: 5000,
        })).toEqual({ tier: "current", source: "price", legacy: false });
    });

    it("says it does not know rather than guessing", () => {
        expect(resolveTier({})).toEqual({ tier: "unknown", source: "unknown", legacy: false });
    });
});
