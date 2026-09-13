import { describe, it, expect } from "vitest";
import { priceLookupFor, resolveBilling, GENERIC_SOURCES } from "./billing-prices";
import { CONNECTION_KEY_TO_SOURCE, SOURCE_TO_CONNECTION_KEY } from "./subscription-key";

/**
 * The price and the connection a checkout names used to be chosen by two
 * different queries, so an account whose primary connection was not the
 * Shopify pair could be filed against its own connection and charged the
 * Shopify product. Whatever the page, both have to name the same pair.
 */
describe("which connection a checkout pays for, and at which price", () => {
    const never = async (): Promise<string> => { throw new Error("primary connection read for a page that names its own"); };

    it("prices a generic page on the account's primary connection, whatever the pair", () => Promise.all(
        [...GENERIC_SOURCES].flatMap((raw) => Object.keys(CONNECTION_KEY_TO_SOURCE).map(async (primary) => {
            const { connectionKey, source } = await resolveBilling(raw, null, async () => primary);
            expect(connectionKey).toBe(primary);
            expect(source).not.toBeNull();
            expect(SOURCE_TO_CONNECTION_KEY[source!], `${raw || '""'} on ${primary}`).toBe(primary);
            expect(priceLookupFor(source!, "monthly")).toBeTruthy();
        })),
    ));

    it("does not sell the Shopify product to a Stripe→Moloni account paying from Faturação", async () => {
        const { source } = await resolveBilling("faturacao", undefined, async () => "stripe:moloni");
        expect(priceLookupFor(source!, "monthly")).toBe("stripe-moloni-monthly");
    });

    it("lets an explicit key decide, without asking for the primary", async () => {
        expect(await resolveBilling("dashboard", "stripe_connect:invoicexpress", never))
            .toEqual({ connectionKey: "stripe_connect:invoicexpress", source: "stripe-connect-ix" });
        expect(await resolveBilling("faturacao", "shopify:invoicexpress", never))
            .toEqual({ connectionKey: "shopify:invoicexpress", source: "faturacao" });
    });

    it("keeps a pair page on its own pair", async () => {
        expect(await resolveBilling("lodgify-moloni", null, never))
            .toEqual({ connectionKey: "lodgify:moloni", source: "lodgify-moloni" });
    });

    it("prices nothing for a primary connection nobody sells, instead of the Shopify pair", async () => {
        const { source } = await resolveBilling("", null, async () => "fareharbor:moloni");
        expect(source).toBeNull();
    });
});

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
