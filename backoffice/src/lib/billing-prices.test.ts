import { describe, it, expect } from "vitest";
import { priceLookupFor } from "./billing-prices";

/**
 * The card beside the payment form and the button that charges read this same
 * function. When they disagree the page quotes a price the client is not
 * charged, which is the bug the amounts were moved out of the markup to fix.
 */
describe("which price is billed", () => {
    it("bills each pair its own product", () => {
        expect(priceLookupFor("lodgify-ix", "monthly")).toBe("lodgify-ix-monthly");
        expect(priceLookupFor("stripe-connect-moloni", "annual")).toBe("stripe-connect-moloni-yearly");
    });

    it("bills a legacy client the old plan, whichever pair they are joining", () => {
        expect(priceLookupFor("lodgify-ix", "monthly", { legacy: true })).toBe("stripe-ix-monthly");
        expect(priceLookupFor("stripe-connect-moloni", "annual", { legacy: true })).toBe("stripe-ix-yearly");
        // The old plan is a plan, not a pair: an unknown source that would
        // otherwise be refused still has an answer once the client is on it.
        expect(priceLookupFor("lodgify-vendus", "annual", { legacy: true })).toBe("stripe-ix-yearly");
    });

    it("refuses a source nobody sells", () => {
        expect(priceLookupFor("lodgify-vendus", "annual")).toBeNull();
        expect(priceLookupFor("", "annual", { legacy: true })).toBe("stripe-ix-yearly");
    });
});
