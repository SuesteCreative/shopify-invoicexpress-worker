/**
 * Where a pending invite token waits between the page that saw it and the first
 * authenticated render that claims it.
 *
 * Kept apart from the hook, with no imports at all, because the root test run
 * (CI's `npm test`) picks up backoffice/src/lib tests without installing the
 * backoffice's dependencies: a test that reached React through the hook failed
 * there with "Cannot find package 'react'" while passing on every machine that
 * has it.
 */

const DAY_MS = 86_400_000;

/**
 * With `ttlDays`, the token goes to `localStorage` and outlives the tab: the
 * referral link needs that, because sign-up often finishes in another tab (an
 * e-mail verification link opens one) and sessionStorage belongs to the tab that
 * saw the link. Without it, the tab-scoped behaviour onboarding invites were
 * built with.
 */
export function stashInvite(key: string, token: string, ttlDays?: number): void {
    try {
        if (ttlDays) window.localStorage.setItem(key, JSON.stringify({ token, expires: Date.now() + ttlDays * DAY_MS }));
        else window.sessionStorage.setItem(key, token);
    } catch { /* private mode */ }
}

/** What is waiting under `key`. An expired entry is removed on the way past. */
export function readInvite(key: string): string | undefined {
    try {
        const raw = window.localStorage.getItem(key);
        if (raw) {
            let entry: any = null;
            try { entry = JSON.parse(raw); } catch { /* not ours to trust */ }
            if (typeof entry?.token === "string" && Number(entry.expires) > Date.now()) return entry.token;
            window.localStorage.removeItem(key);
        }
    } catch { /* storage blocked: fall back to the tab */ }
    // A token stashed before it moved to localStorage, or by a caller that never did.
    try { return window.sessionStorage.getItem(key) ?? undefined; } catch { return undefined; }
}

export function clearInvite(key: string): void {
    try { window.localStorage.removeItem(key); } catch { /* ignore */ }
    try { window.sessionStorage.removeItem(key); } catch { /* ignore */ }
}
