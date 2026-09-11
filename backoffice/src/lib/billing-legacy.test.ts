import { describe, it, expect } from "vitest";
import { LEGACY_MONTHLY_SUNSET, currentPriceCents, sunsetAt, tierOf } from "./billing-legacy";

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
