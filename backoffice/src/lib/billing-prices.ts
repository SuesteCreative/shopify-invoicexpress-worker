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
 * Most pairs are stable literal lookup keys, created by hand in Stripe with
 * exactly these names. Only the original Shopify→IX product keeps its keys in
 * the environment, because that is where they have always been.
 */

export type BillingPlan = "monthly" | "annual";

/**
 * The old plan, 5 €/month and 50 €/year, for the clients entitled to keep it.
 *
 * One pair of prices for every integration, not one per pair: the plan is the
 * same plan, only the amount differs, and the fleet has exactly two of these in
 * Stripe. They live under the names the first Stripe→IX clients bought on,
 * which is where the 5 € and the 50 € have always been.
 *
 * If a dedicated pair is ever created for tidiness, it is these two lines that
 * change and nothing else.
 */
const LEGACY_PRICE_IDS: Record<BillingPlan, string> = {
    monthly: "stripe-ix-monthly",
    annual: "stripe-ix-yearly",
};

/**
 * Which price to bill.
 *
 * `legacy` is the client's own answer, read from `subscriptions.legacy_price`
 * (0054) — a migrated client who was promised the old plan, or one whose
 * subscription arrived through an invite that carried it. It short-circuits the
 * pair entirely: a legacy client pays the legacy amount whichever two platforms
 * they are joining.
 */
export function priceLookupFor(source: string, plan: BillingPlan, opts?: { legacy?: boolean }): string | null {
    const annual = plan === "annual";
    if (opts?.legacy) return LEGACY_PRICE_IDS[plan];
    switch (source) {
        // The original Shopify→IX product. It read its two ids from the
        // environment, where they spell out these very names; said plainly like
        // every other pair, it is two fewer variables to have set in production
        // and it keeps this module free of anything that only exists inside a
        // request, which is what makes it testable.
        case "":
        case "faturacao":
            return annual ? "shopify-ix-yearly" : "shopify-ix-monthly";
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

/**
 * Whether this client pays the old plan.
 *
 * `subscriptions.legacy_price` is the operator's answer (0054) and the only one
 * consulted here: the derivations behind it — the Stripe price, the amounts
 * charged — describe a subscription that already exists, and this question is
 * asked before one does. The connection being subscribed answers first; any
 * other row of the account answers second, because a client promised the old
 * plan was promised it for the account, not for one pipe.
 */
export async function isLegacyClient(db: any, userId: string, connectionKey: string | null): Promise<boolean> {
    try {
        if (connectionKey) {
            const own: any = await db
                .prepare("SELECT legacy_price FROM subscriptions WHERE user_id = ? AND connection_key = ?")
                .bind(userId, connectionKey)
                .first();
            if (own?.legacy_price != null) return Number(own.legacy_price) === 1;
        }
        const any: any = await db
            .prepare("SELECT 1 AS yes FROM subscriptions WHERE user_id = ? AND legacy_price = 1 LIMIT 1")
            .bind(userId)
            .first();
        return !!any;
    } catch (e: any) {
        // Before migration 0054 lands, nobody is legacy — which is what every
        // caller did until it existed.
        console.warn("[billing-prices] legacy lookup failed:", e?.message ?? e);
        return false;
    }
}
