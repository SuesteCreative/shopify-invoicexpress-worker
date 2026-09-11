import { getStripe } from "@/lib/stripe";

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
    const book = new Map<string, any>();
    const add = (p: any) => {
        book.set(p.id, p);
        if (p.lookup_key) book.set(p.lookup_key, p);
    };

    try {
        const stripe = getStripe();
        // The whole catalogue is a couple of dozen prices and changes almost
        // never, so a page or two is the whole answer. Asking per subscription
        // would be one round trip per client on a page that lists all of them.
        let page = await stripe.prices.list({ limit: 100 });
        page.data.forEach(add);
        let guard = 0;
        while (page.has_more && guard++ < 5) {
            page = await stripe.prices.list({ limit: 100, starting_after: page.data.at(-1)?.id });
            page.data.forEach(add);
        }
    } catch (e: any) {
        // A missing key or a Stripe outage costs the forecast, not the page.
        console.error("[admin/finance] price book failed:", e?.message ?? e);
    }
    return book;
}
