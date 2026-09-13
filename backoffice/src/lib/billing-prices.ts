// Relative, not aliased: this module is unit-tested and the runner at the repo
// root does not resolve the `@/` alias.
import { CONNECTION_KEY_TO_SOURCE, SOURCE_TO_CONNECTION_KEY, keyFromRequest } from "./subscription-key";

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
 * Where a lookup key is NOT simply the page's own slug.
 *
 * Three aliases for the Shopify pair, which is sold from the billing page and
 * from an empty source as well as from its own wizard; and one irregular stem,
 * Connect→InvoiceXpress, whose prices were created spelling the destination out
 * while every other pair abbreviates it to `ix`. Those prices carry live
 * subscriptions, so renaming them buys tidiness and nothing else.
 *
 * Everything else derives: the stem IS the slug. Adding a pair is therefore a
 * page plus the two maps in `subscription-key`, and there is no third list to
 * forget — which is what `price-catalogue.test.ts` holds it to.
 */
const STEM_EXCEPTIONS: Record<string, string> = {
    "": "shopify-ix",
    faturacao: "shopify-ix",
    "stripe-connect-ix": "stripe-connect-invoicexpress",
};

/** Which price to bill. Null for a source nothing sells, which the callers turn
 *  into a 400 rather than quietly charging the wrong pair. */
export function priceLookupFor(source: string, plan: BillingPlan): string | null {
    // Sellable is decided by the pair map, never by the shape of the string:
    // deriving a key from any input would turn a typo into a lookup nobody has,
    // resolved at the till instead of at the 400 it should be.
    if (!(source in SOURCE_TO_CONNECTION_KEY)) return null;
    const stem = STEM_EXCEPTIONS[source] ?? source;
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

/** Pages that sit above every integration and so cannot name the one they sell. */
export const GENERIC_SOURCES = new Set(["", "faturacao", "dashboard"]);

/**
 * Which connection a checkout pays for, and the price it is sold at.
 *
 * One answer, not two. The connection used to come from the account (legacy
 * Shopify shop or oldest connection) while the price came from a second query
 * that only looked at `connections`, and only for "dashboard": "faturacao" and
 * "" always priced the Shopify pair. An account paying for another pair was
 * filed against its own connection and charged the Shopify product.
 *
 * So the connection is chosen first and the price is READ from it. An explicit
 * key wins; a generic page takes the account's primary connection; a pair page
 * names its own. The source comes back null for a connection nothing sells,
 * which the callers turn into a 400 rather than defaulting to the Shopify price.
 *
 * `primaryKey` is passed in rather than imported: the lookup lives next to
 * `getRequestContext`, and this has to stay testable.
 */
export async function resolveBilling(
    rawSource: string,
    explicitKey: string | null | undefined,
    primaryKey: () => Promise<string>,
): Promise<{ connectionKey: string; source: string | null }> {
    const generic = GENERIC_SOURCES.has(rawSource);
    const connectionKey = explicitKey
        ? keyFromRequest(explicitKey, null)
        : generic ? await primaryKey() : keyFromRequest(null, rawSource);
    const source = generic ? CONNECTION_KEY_TO_SOURCE[connectionKey] ?? null : rawSource;
    return { connectionKey, source };
}
