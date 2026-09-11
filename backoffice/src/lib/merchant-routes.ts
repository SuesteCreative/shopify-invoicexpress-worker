/**
 * Where a given (source, destination) pair lives in the merchant's own app.
 *
 * Two spellings have to be reconciled and both have bitten before: the route is
 * kebab-cased while the kind is snake_cased (`stripe_connect` → `stripe-connect`),
 * and InvoiceXpress is `ix` in a path and `invoicexpress` everywhere else.
 *
 * It matters most on the admin console's impersonate button, which sets the
 * cookie and then navigates: a wrong slug lands an operator on a 404 while
 * already wearing somebody else's session, which is the worst possible place to
 * find out about a typo.
 *
 * Not every pair the database accepts has a page — EuPago into Moloni is a
 * valid connection with no configurator — so unknown pairs resolve to the index
 * instead of to a guess.
 */

/** Kept in step with the directories under app/[locale]/(dashboard)/integrations
 *  by merchant-routes.test.ts, which reads them off disk. */
export const MERCHANT_ROUTE_SLUGS = [
    "shopify-ix", "shopify-moloni", "shopify-vendus",
    "stripe-ix", "stripe-moloni", "stripe-vendus",
    "stripe-connect-ix", "stripe-connect-moloni",
    "eupago-ix",
    "lodgify-ix", "lodgify-moloni", "lodgify-vendus",
] as const;

const SLUGS = new Set<string>(MERCHANT_ROUTE_SLUGS);

export function merchantRouteSlug(source: string, destination: string): string {
    const src = source === "stripe_connect" ? "stripe-connect" : source;
    const dest = destination === "invoicexpress" ? "ix" : destination;
    return `${src}-${dest}`;
}

/** A locale-prefixed path, because the merchant app does live under [locale]. */
export function merchantIntegrationHref(source: string, destination: string, locale = "pt"): string {
    const slug = merchantRouteSlug(source, destination);
    return SLUGS.has(slug)
        ? `/${locale}/integrations/${slug}`
        : `/${locale}/integrations`;
}
