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
    // Lodgify→IX runs on the same product/price as Shopify→IX, but it is its
    // OWN connection: without this line every Lodgify+IX merchant's payment was
    // filed against a `shopify:invoicexpress` connection they do not have, and
    // the billing page — which reads the connection they DO have — kept showing
    // the account as suspended (Farracemota, 10/09/2026).
    "lodgify-ix": "lodgify:invoicexpress",
    "stripe-moloni": "stripe:moloni",
    // The Connect wizard is its own page and its own connection, but the same
    // product at the same price. Only the key differs.
    "stripe-connect-moloni": "stripe_connect:moloni",
    // Connect into InvoiceXpress. Its own connection and its own wizard, on the
    // Stripe→IX product: without a key here the subscribe button answers 400.
    "stripe-connect-ix": "stripe_connect:invoicexpress",
    "lodgify-moloni": "lodgify:moloni",
    // The five pairs that had a guided page and no way to be paid for: a
    // merchant could set the connection up and was never asked for money, and
    // pressing subscribe answered 400. They are ordinary pairs in every other
    // respect, and they are priced like the rest (12/09/2026).
    "shopify-moloni": "shopify:moloni",
    "shopify-vendus": "shopify:vendus",
    "stripe-vendus": "stripe:vendus",
    "lodgify-vendus": "lodgify:vendus",
    "eupago-ix": "eupago:invoicexpress",
};

/** The reverse, for the dashboard card, which must resolve a page from a key. */
export const CONNECTION_KEY_TO_SOURCE: Record<string, string> = {
    "shopify:invoicexpress": "faturacao",
    "stripe:invoicexpress": "stripe-ix",
    "lodgify:invoicexpress": "lodgify-ix",
    "stripe:moloni": "stripe-moloni",
    "stripe_connect:moloni": "stripe-connect-moloni",
    "stripe_connect:invoicexpress": "stripe-connect-ix",
    "lodgify:moloni": "lodgify-moloni",
    "shopify:moloni": "shopify-moloni",
    "shopify:vendus": "shopify-vendus",
    "stripe:vendus": "stripe-vendus",
    "lodgify:vendus": "lodgify-vendus",
    "eupago:invoicexpress": "eupago-ix",
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

/**
 * A timestamp from D1, as milliseconds, whichever way it was written.
 *
 * The two tables disagree on format and it is not cosmetic. SQLite's
 * CURRENT_TIMESTAMP writes `2026-09-08 14:52:25`; our own inserts write
 * `2026-09-08T14:49:59.950Z`. Compared as STRINGS the space sorts before the
 * `T`, so a row written two and a half minutes LATER reads as older — which is
 * exactly how Wim Hof Method's subscription was attached to the Shopify shop it
 * was not bought for (measured 08/09/2026, migration 0044).
 *
 * A bare timestamp is UTC: that is what SQLite means by CURRENT_TIMESTAMP, and
 * reading it as local time would reintroduce the same class of error twice a
 * year.
 */
export function dbTimeMs(value?: string | null): number | null {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw);
    const withT = raw.includes("T") ? raw : raw.replace(" ", "T");
    const ms = Date.parse(hasZone ? withT : `${withT}Z`);
    return Number.isNaN(ms) ? null : ms;
}

/**
 * True when the Shopify shop is the account's oldest integration — the one an
 * unattributed subscription was bought for. An unparseable or missing date
 * cannot win the comparison, so a connection with a real date is preferred over
 * a shop with none.
 */
export function shopIsOldest(shopCreatedAt?: string | null, connCreatedAt?: string | null): boolean {
    const shop = dbTimeMs(shopCreatedAt);
    if (shop === null) return false;
    const conn = dbTimeMs(connCreatedAt);
    if (conn === null) return true;
    return shop <= conn;
}
