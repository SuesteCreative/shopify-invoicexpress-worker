import { getStripe } from "@/lib/stripe";
import { buildPriceBook } from "./price-catalogue";

export { buildPriceBook };

/**
 * Everything Stripe knows about what things cost, in one request.
 *
 * Indexed by BOTH the price id and its lookup key, because `subscriptions.
 * price_id` holds either. Checkout resolves a lookup key like
 * `shopify-ix-monthly` into a real price and, depending on the path it took,
 * stores one or the other — so nine of the fleet's live subscriptions carry a
 * lookup key in a column named for an id. Keying on `p.id` alone silently
 * priced all of them at zero.
 *
 * Archived prices are included deliberately: a client stays on the plan they
 * signed up to long after it stops being sold, and leaving those out would
 * understate MRR by exactly the legacy accounts that have paid longest.
 */
export async function priceBook(): Promise<Map<string, any>> {
    const all: any[] = [];

    try {
        const stripe = getStripe();
        // The whole catalogue is a couple of dozen prices and changes almost
        // never, so a page or two is the whole answer. Asking per subscription
        // would be one round trip per client on a page that lists all of them.
        let page = await stripe.prices.list({ limit: 100 });
        all.push(...page.data);
        let guard = 0;
        while (page.has_more && guard++ < 5) {
            page = await stripe.prices.list({ limit: 100, starting_after: page.data.at(-1)?.id });
            all.push(...page.data);
        }
    } catch (e: any) {
        // A missing key or a Stripe outage costs the forecast, not the page.
        console.error("[admin/finance] price book failed:", e?.message ?? e);
    }

    // Ids first, lookup keys second, so a KEY always wins the collision.
    // Our older prices were created with the lookup key as their id, so when one
    // is replaced the retired price keeps that string as its id while the live
    // one holds it as its key. Indexed in one pass, whichever Stripe listed last
    // would win — and the catalogue would report the price it had just retired,
    // for ever.
    return buildPriceBook(all);
}
