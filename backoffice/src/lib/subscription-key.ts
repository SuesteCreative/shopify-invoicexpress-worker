/**
 * Which connection a subscription pays for.
 *
 * `<source_kind>:<destination_kind>` — the same string the checkout route
 * already used to pick a price, now also the second half of the subscriptions
 * primary key (migration 0044).
 *
 * The legacy Shopify integration has no `connections` row, so this names the
 * PAIR rather than a row id: it is stable whether or not that backfill ever
 * happens, and it survives a connection being deleted and set up again — which
 * a row id would not, and which would silently un-bill the merchant.
 */
export const DEFAULT_CONNECTION_KEY = "shopify:invoicexpress";

/** The wizard/page a checkout was started from → the connection it pays for. */
export const SOURCE_TO_CONNECTION_KEY: Record<string, string> = {
    "": DEFAULT_CONNECTION_KEY,
    faturacao: DEFAULT_CONNECTION_KEY,
    "shopify-ix": DEFAULT_CONNECTION_KEY,
    "stripe-ix": "stripe:invoicexpress",
    "stripe-moloni": "stripe:moloni",
    "lodgify-moloni": "lodgify:moloni",
};

/** The reverse, for the dashboard card, which must resolve a page from a key. */
export const CONNECTION_KEY_TO_SOURCE: Record<string, string> = {
    "shopify:invoicexpress": "faturacao",
    "stripe:invoicexpress": "stripe-ix",
    "stripe:moloni": "stripe-moloni",
    "lodgify:moloni": "lodgify-moloni",
};

export function connectionKeyOf(sourceKind?: string | null, destinationKind?: string | null): string {
    const s = String(sourceKind ?? "").trim().toLowerCase();
    const d = String(destinationKind ?? "").trim().toLowerCase();
    if (!s || !d) return DEFAULT_CONNECTION_KEY;
    return `${s}:${d}`;
}

/**
 * The key a checkout/billing call is about.
 *
 * An explicit key wins; otherwise the page it came from decides. An unknown
 * page falls back to the default rather than inventing a key nothing bills —
 * the checkout route rejects unknown SOURCES on its own, before this is read.
 */
export function keyFromRequest(explicitKey?: string | null, source?: string | null): string {
    const k = String(explicitKey ?? "").trim().toLowerCase();
    if (k.includes(":")) return k;
    return SOURCE_TO_CONNECTION_KEY[String(source ?? "").trim()] ?? DEFAULT_CONNECTION_KEY;
}
