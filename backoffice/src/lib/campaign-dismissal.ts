/**
 * Who gets to silence the campaign announcement, and for how long.
 *
 * Two acts, two lifetimes, and the whole point is that they do not collapse
 * into one:
 *
 *   - "Não mostrar novamente" is permanent, per user, and the only thing that
 *     is permanent;
 *   - every other close — the X, "Agora não", Esc, the backdrop, following the
 *     CTA or the terms — lasts one SIGN-IN. Signing in again brings it back.
 *
 * The sign-in boundary is Clerk's session id. The first version reached for a
 * cookie with no expiry to mean "until the browser closes" and that is not what
 * a browser does with one: Chrome and Edge restore session cookies with the
 * tabs, so a single X silenced the announcement forever. That is the bug this
 * file exists to make testable.
 *
 * Kept out of the component and given a `Storage` shape so the rule can be
 * exercised without a DOM.
 */

export const CAMPAIGN_DISMISSED_KEY = "rioko_campaign_dismissed:";
export const CAMPAIGN_CLOSED_KEY = "rioko_campaign_closed:";

/** The slice of `localStorage` this needs. */
export interface KeyValueStore {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

/** Every key held, for the prune below. `localStorage` satisfies this natively. */
function keysOf(store: KeyValueStore): string[] {
    return Object.keys(store as unknown as Record<string, unknown>);
}

export function isCampaignDismissed(
    store: KeyValueStore,
    userId: string,
    sessionId: string | null | undefined,
): boolean {
    if (store.getItem(CAMPAIGN_DISMISSED_KEY + userId) === "1") return true;
    return !!sessionId && store.getItem(CAMPAIGN_CLOSED_KEY + sessionId) === "1";
}

export function rememberCampaignClose(
    store: KeyValueStore,
    userId: string,
    sessionId: string | null | undefined,
    forever: boolean,
): void {
    if (forever) {
        store.setItem(CAMPAIGN_DISMISSED_KEY + userId, "1");
        return;
    }
    if (!sessionId) return;
    // One key at a time: a merchant who signs in every morning would otherwise
    // leave one dead entry per day behind forever.
    for (const k of keysOf(store)) {
        if (k.startsWith(CAMPAIGN_CLOSED_KEY)) store.removeItem(k);
    }
    store.setItem(CAMPAIGN_CLOSED_KEY + sessionId, "1");
}
