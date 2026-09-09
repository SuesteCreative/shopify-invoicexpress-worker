/**
 * One-shot CSRF nonce for the OAuth round trips.
 *
 * Both Stripe and Moloni send the merchant away to a consent screen and bring
 * them back to us with a `code` in the query string. Without a `state` we would
 * accept any code anyone put in that URL and attach the resulting account to
 * whoever happened to be logged in — the textbook OAuth CSRF. Stripe's own
 * security guidance calls it out explicitly.
 *
 * It lives on the `connections` row rather than in a cookie or a KV entry
 * because the row is the thing being authorised, and it has to survive a round
 * trip that may take minutes and may finish in a different tab.
 */

export const OAUTH_STATE_TTL_MS = 15 * 60_000;

export function newOAuthState(): { state: string; expiresAt: string } {
    return {
        state: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString(),
    };
}

/** Constant-time-ish compare plus the expiry check, in one place. */
export function isValidOAuthState(
    stored: string | null | undefined,
    storedExpiresAt: string | null | undefined,
    received: string | null | undefined,
): boolean {
    if (!stored || !received) return false;
    if (stored.length !== received.length) return false;
    let diff = 0;
    for (let i = 0; i < stored.length; i++) diff |= stored.charCodeAt(i) ^ received.charCodeAt(i);
    if (diff !== 0) return false;
    const expires = Date.parse(String(storedExpiresAt ?? ""));
    // A state with no expiry is treated as expired: it can only come from a row
    // written by something that did not follow this flow.
    return Number.isFinite(expires) && expires > Date.now();
}
