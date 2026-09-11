"use client";

import { useCallback, useRef } from "react";

/**
 * Claim an onboarding invite, once, as soon as there is a session.
 *
 * The token reaches the page in the URL and does not survive the trips out of
 * it: the Clerk sign-up and the Stripe and Moloni consent screens all come back
 * through a fixed map of paths, deliberately, so no redirect target can be
 * taken from a query string. It is stashed in `sessionStorage` on arrival and
 * read back after, which is all it has to survive — once claimed, the coverage
 * lives on the account and every later load reads it from the server.
 *
 * Errors are returned, never thrown: a bad or spent invite must not stop a
 * merchant from finishing the setup and paying the normal way.
 */

const KEY = "rioko_onboarding_invite";

export type InviteClaim =
    | { state: "idle" }
    | { state: "claimed" }
    | { state: "refused"; reason: string };

export function useOnboardingInvite(invite: string | undefined) {
    const done = useRef(false);

    // Stash on the very first render that has one, before anything can navigate
    // away. Reading it back is what makes the invite survive the sign-up.
    if (typeof window !== "undefined" && invite && !done.current) {
        try { window.sessionStorage.setItem(KEY, invite); } catch { /* private mode */ }
    }

    return useCallback(async (): Promise<InviteClaim> => {
        if (done.current) return { state: "idle" };
        let token = invite;
        if (!token && typeof window !== "undefined") {
            try { token = window.sessionStorage.getItem(KEY) ?? undefined; } catch { token = undefined; }
        }
        if (!token) return { state: "idle" };
        done.current = true;

        try {
            const res = await fetch("/api/onboarding/invite/claim", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token }),
            });
            const json: any = await res.json().catch(() => ({}));
            if (!res.ok) return { state: "refused", reason: String(json.error ?? `HTTP ${res.status}`) };
            try { window.sessionStorage.removeItem(KEY); } catch { /* ignore */ }
            return { state: "claimed" };
        } catch (e: any) {
            return { state: "refused", reason: e?.message ?? "network" };
        }
    }, [invite]);
}
