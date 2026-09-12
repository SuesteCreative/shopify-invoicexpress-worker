// Relative, not aliased: this module is unit-tested and the runner at the repo
// root does not resolve the `@/` alias.
import { CONNECTION_KEY_TO_SOURCE } from "./subscription-key";

/**
 * Which Stripe price each integration bills on.
 *
 * It lived inside the checkout route, which was fine while the only thing that
 * needed it was the checkout. The onboarding pages print the amount next to the
 * card form, and printed it from three hardcoded strings: a pair whose price is
 * not 7,50 € a month was advertised at a price it does not have. They now ask
 * Stripe, and the two callers have to agree on which price that is.
 *
 * Every pair is a stable literal lookup key, created in Stripe under exactly
 * these names by the catalogue endpoint (`/api/admin/finance/prices`), never by
 * hand. Nothing here reads the environment: that is what makes it testable, and
 * it is two fewer variables to have set in production.
 *
 * There is no legacy price here on purpose. The old plan, 5 €/50 €, is what a
 * migrated client's EXISTING subscription already bills on — inherited, marked
 * `subscriptions.legacy_price = 1`, and left alone. It is not something we sell:
 * every new integration is sold at the Rioko 2.0 price, including to a client
 * who holds an old subscription on another pipe.
 */

export type BillingPlan = "monthly" | "annual";

/**
 * The lookup-key stem of each sellable pair, keyed by the page the checkout was
 * started from.
 *
 * Irregular by history, not by design: every destination is abbreviated `ix`
 * except Connect→InvoiceXpress, whose prices were created spelling the word out
 * and carry live subscriptions. Renaming a live key buys tidiness and nothing
 * else, so it stays as it is and is written down here instead.
 *
 * A pair belongs in this map exactly when it has a guided page that can sell it
 * — `price-catalogue.test.ts` holds the three lists to that one rule.
 */
const PRICE_STEM: Record<string, string> = {
    "": "shopify-ix",
    faturacao: "shopify-ix",
    // The slug of the Shopify route itself. Absent for a long time, so a
    // checkout started with the page's own name answered 400.
    "shopify-ix": "shopify-ix",
    "shopify-moloni": "shopify-moloni",
    "shopify-vendus": "shopify-vendus",
    "stripe-ix": "stripe-ix",
    "stripe-moloni": "stripe-moloni",
    "stripe-vendus": "stripe-vendus",
    "stripe-connect-ix": "stripe-connect-invoicexpress",
    "stripe-connect-moloni": "stripe-connect-moloni",
    "lodgify-ix": "lodgify-ix",
    "lodgify-moloni": "lodgify-moloni",
    "lodgify-vendus": "lodgify-vendus",
    "eupago-ix": "eupago-ix",
};

/** Which price to bill. Null for a source nothing sells, which the callers turn
 *  into a 400 rather than quietly charging the wrong pair. */
export function priceLookupFor(source: string, plan: BillingPlan): string | null {
    const stem = PRICE_STEM[source];
    if (!stem) return null;
    return `${stem}-${plan === "annual" ? "yearly" : "monthly"}`;
}

/**
 * The price behind a lookup key.
 *
 * Accepts any of: a real price id (price_xxx), a custom id, or a lookup key.
 *
 * The LOOKUP KEY is asked first, and that order is load-bearing. Our older
 * prices were created with the lookup key as their id too, so when one has to
 * be replaced — a pair priced wrong, say — the new price takes the key while
 * the old one keeps the id. Retrieving first would hand back the price we just
 * retired, and archiving it would make the checkout answer "Price is inactive"
 * instead. A `price_` id goes straight to retrieve because no lookup key can
 * ever look like one; anything else falls back to retrieve for the custom ids
 * `subscriptions.price_id` still holds.
 */
export async function resolvePrice(stripe: any, lookupOrId: string): Promise<any | null> {
    if (!lookupOrId.startsWith("price_")) {
        try {
            const prices = await stripe.prices.list({ lookup_keys: [lookupOrId], limit: 1, active: true });
            if (prices.data[0]) return prices.data[0];
        } catch {
            // a malformed key is not fatal — fall through to the id
        }
    }
    try {
        const price = await stripe.prices.retrieve(lookupOrId);
        if (price) return price;
    } catch {
        // neither a live lookup key nor a valid id
    }
    return null;
}

/**
 * Which product a page that cannot name one is really asking about.
 *
 * The dashboard card sits above every integration, so it says "dashboard" and
 * the account's own set-up decides: oldest connection wins, and an account with
 * nothing set up yet falls back to the original Shopify product. Shared with
 * the checkout, because a card that prints one price while the button charges
 * another is the bug this file exists to prevent.
 */
export async function resolveBillingSource(db: any, userId: string, rawSource: string): Promise<string> {
    if (rawSource !== "dashboard") return rawSource;
    const conn: any = await db.prepare(
        "SELECT source_kind, destination_kind FROM connections WHERE user_id = ? AND status IN ('active','paused') ORDER BY created_at ASC LIMIT 1"
    ).bind(userId).first();
    return (conn && CONNECTION_KEY_TO_SOURCE[`${conn.source_kind}:${conn.destination_kind}`]) || "faturacao";
}
