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

    it("spells InvoiceXpress out for the Connect pair, which is where its live prices are", () => {
        expect(priceLookupFor("stripe-connect-ix", "monthly")).toBe("stripe-connect-invoicexpress-monthly");
        expect(priceLookupFor("stripe-connect-ix", "annual")).toBe("stripe-connect-invoicexpress-yearly");
    });

    it("answers the Shopify pair by every name its pages use", () => {
        // The empty source, the billing page, and the route's own slug — the
        // last of which answered 400 until 12/09/2026.
        for (const source of ["", "faturacao", "shopify-ix"]) {
            expect(priceLookupFor(source, "monthly")).toBe("shopify-ix-monthly");
            expect(priceLookupFor(source, "annual")).toBe("shopify-ix-yearly");
        }
    });

    it("sells the current price to everyone, including a client on the old plan", () => {
        // There is no legacy branch any more. 5 €/50 € is what an inherited
        // subscription already bills on; a new integration is never sold at it,
        // so there is nothing here for a caller to pass.
        expect(priceLookupFor("lodgify-ix", "monthly")).toBe("lodgify-ix-monthly");
    });

    it("refuses a source nobody sells", () => {
        expect(priceLookupFor("fareharbor-moloni", "annual")).toBeNull();
        expect(priceLookupFor("dashboard", "monthly")).toBeNull();
    });
});
