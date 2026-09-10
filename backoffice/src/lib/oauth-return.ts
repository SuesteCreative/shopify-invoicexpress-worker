/**
 * Where a guided OAuth round trip puts the merchant down.
 *
 * Several pages drive the same Stripe Connect flow: the dashboard wizards for
 * Moloni and for InvoiceXpress, and the public onboarding page a client is sent
 * a link to. Each sends the
 * merchant off to Stripe and to Moloni, and each must get them back on the page
 * they started on, so the start of the flow writes a SLUG on the connection row
 * and the callbacks resolve it here.
 *
 * A slug through a fixed map, never a path taken from the request: a redirect
 * target that arrives in a query string and is obeyed is an open redirect, and
 * these links are emailed to clients.
 */

export const RETURN_SLUG_WIZARD = "wizard";
export const RETURN_SLUG_WIZARD_IX = "wizard-ix";
export const RETURN_SLUG_ONBOARDING_CONNECT_MOLONI = "onboarding-stripe-connect-moloni";

const RETURN_PATHS: Record<string, string> = {
    [RETURN_SLUG_WIZARD]: "/integrations/stripe-connect-moloni",
    [RETURN_SLUG_WIZARD_IX]: "/integrations/stripe-connect-ix",
    [RETURN_SLUG_ONBOARDING_CONNECT_MOLONI]: "/onboarding/stripe-connect-moloni",
};

/** The slug as it may be stored, or undefined when it is not one we know. */
export function normalizeReturnSlug(slug: unknown): string | undefined {
    const value = String(slug ?? "");
    return Object.prototype.hasOwnProperty.call(RETURN_PATHS, value) ? value : undefined;
}

/** A locale-prefixed app path. Anything unknown lands on the dashboard wizard. */
export function resolveReturnPath(slug: unknown, locale: unknown): string {
    const path = RETURN_PATHS[normalizeReturnSlug(slug) ?? RETURN_SLUG_WIZARD];
    return `/${locale === "en" ? "en" : "pt"}${path}`;
}
