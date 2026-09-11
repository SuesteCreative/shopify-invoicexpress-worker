import { describe, it, expect } from "vitest";
import { afterOnboardingPath, canConnectPair, configuratorPath, onboardingPath, STRIPE_CONNECT_ENABLED } from "./platforms";

/**
 * The general onboarding hands the merchant to whatever these answer. A pair
 * that resolves to a page which does not exist is a dead end at the exact
 * moment a new client is deciding whether this product works.
 */
describe("platform pair routing", () => {
    it("routes a known pair to its configurator", () => {
        expect(configuratorPath("shopify", "invoicexpress")).toBe("/integrations/shopify-ix");
        expect(configuratorPath("lodgify", "moloni")).toBe("/integrations/lodgify-moloni");
    });

    it("refuses a pair nobody built", () => {
        expect(configuratorPath("eupago", "moloni")).toBeNull();
        expect(canConnectPair("eupago", "moloni")).toBe(false);
        expect(configuratorPath(null, "moloni")).toBeNull();
    });

    it("sends a pair with no guided onboarding to its own configurator", () => {
        expect(onboardingPath("shopify", "invoicexpress")).toBeNull();
        expect(afterOnboardingPath("shopify", "invoicexpress")).toBe("/integrations/shopify-ix");
    });

    it("falls back to the dashboard only when the pair leads nowhere", () => {
        expect(afterOnboardingPath("eupago", "moloni")).toBe("/dashboard");
        expect(afterOnboardingPath(null, null)).toBe("/dashboard");
    });

    it("follows the Stripe Connect flag, both ways", () => {
        // The flag is unset under vitest, which is the case that matters: with
        // Connect dark, its pairs must be unreachable rather than lead to an
        // endpoint that answers 400.
        const expected = STRIPE_CONNECT_ENABLED ? "/onboarding/stripe-connect-moloni" : null;
        expect(onboardingPath("stripe_connect", "moloni")).toBe(expected);
        expect(afterOnboardingPath("stripe_connect", "moloni")).toBe(expected ?? "/dashboard");
    });
});
