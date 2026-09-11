import { getStripeEnv } from "@/lib/stripe";

/**
 * Which Stripe price each integration bills on.
 *
 * It lived inside the checkout route, which was fine while the only thing that
 * needed it was the checkout. The onboarding pages print the amount next to the
 * card form, and printed it from three hardcoded strings: a pair whose price is
 * not 7,50 € a month was advertised at a price it does not have. They now ask
 * Stripe, and the two callers have to agree on which price that is.
 *
 * Most pairs are stable literal lookup keys, created by hand in Stripe with
 * exactly these names. Only the original Shopify→IX product keeps its keys in
 * the environment, because that is where they have always been.
 */

export type BillingPlan = "monthly" | "annual";

export function priceLookupFor(source: string, plan: BillingPlan): string | null {
    const annual = plan === "annual";
    switch (source) {
        case "":
        case "faturacao":
            return annual ? getStripeEnv("STRIPE_PRICE_YEARLY_LOOKUP") : getStripeEnv("STRIPE_PRICE_MONTHLY_LOOKUP");
        // Each Lodgify pair bills its own product. Lodgify→IX used to ride on the
        // Shopify→IX price and Lodgify→Moloni on a pair of environment variables
        // that spelled out these very keys; both are now said plainly, which is
        // one less thing to configure in production and one less way to 500.
        case "lodgify-ix":
            return annual ? "lodgify-ix-yearly" : "lodgify-ix-monthly";
        case "lodgify-moloni":
            return annual ? "lodgify-moloni-yearly" : "lodgify-moloni-monthly";
        case "stripe-moloni":
            return annual ? "stripe-moloni-yearly" : "stripe-moloni-monthly";
        // Connect has its own product, at the price the onboarding page
        // advertises. It used to bill the Stripe→Moloni pair, where the monthly
        // price does not exist at all and the yearly one is an older 50 €.
        case "stripe-connect-moloni":
            return annual ? "stripe-connect-moloni-yearly" : "stripe-connect-moloni-monthly";
        // The older Stripe → InvoiceXpress pair keeps its own prices, which is
        // what its merchants signed up on.
        case "stripe-ix":
            return annual ? "stripe-ix-yearly" : "stripe-ix-monthly";
        case "stripe-connect-ix":
            return annual ? "stripe-connect-invoicexpress-yearly" : "stripe-connect-invoicexpress-monthly";
        default:
            return null;
    }
}

/**
 * The price behind a lookup key.
 *
 * Accepts any of: a real price id (price_xxx), a custom id, or a lookup key —
 * retrieve first, then fall back to a lookup, which is the order every caller
 * of this has always used.
 */
export async function resolvePrice(stripe: any, lookupOrId: string): Promise<any | null> {
    try {
        const price = await stripe.prices.retrieve(lookupOrId);
        if (price) return price;
    } catch {
        // not a valid id — try lookup_keys
    }
    const prices = await stripe.prices.list({ lookup_keys: [lookupOrId], limit: 1, active: true });
    return prices.data[0] ?? null;
}
