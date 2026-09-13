"use client";

import { useCallback, useRef } from "react";
import { clearInvite, readInvite, stashInvite } from "./invite-storage";

/**
 * Claim an onboarding invite, once, as soon as there is a session.
 *
 * The token reaches the page in the URL and does not survive the trips out of
 * it: the Clerk sign-up and the Stripe and Moloni consent screens all come back
 * through a fixed map of paths, deliberately, so no redirect target can be
 * taken from a query string. It is stashed on arrival and read back after
 * (lib/invite-storage), which is all it has to survive — once claimed, the
 * coverage lives on the account and every later load reads it from the server.
 *
 * Errors are returned, never thrown: a bad or spent invite must not stop a
 * merchant from finishing the setup and paying the normal way.
 */

const KEY = "rioko_onboarding_invite";
const ENDPOINT = "/api/onboarding/invite/claim";

export type InviteClaim =
    | { state: "idle" }
    | { state: "claimed" }
    /** `refusal` is the server's reason code, present only when the answer is final. */
    | { state: "refused"; reason: string; refusal?: string };

/**
 * The referral link needs exactly this behaviour and nothing else, so it passes
 * its own storage key and endpoint rather than growing a second copy of the
 * storage dance. Every existing call site omits the argument and is unchanged.
 */
export interface InviteClaimOptions {
    key?: string;
    endpoint?: string;
    /**
     * Keep the token in `localStorage` for this many days instead of in the tab.
     * The referral link needs it: sign-up often finishes in another tab (an
     * e-mail verification link opens one), sessionStorage belongs to the tab
     * that saw the link, and the invite was dropped without a word — the friend
     * then paid full price. Onboarding invites leave it unset and keep the
     * tab-scoped behaviour they were built with.
     */
    ttlDays?: number;
}

export function useOnboardingInvite(invite: string | undefined, opts: InviteClaimOptions = {}) {
    const done = useRef(false);
    const KEY_ = opts.key ?? KEY;
    const ENDPOINT_ = opts.endpoint ?? ENDPOINT;

    // Stash on the very first render that has one, before anything can navigate
    // away. Reading it back is what makes the invite survive the sign-up.
    if (typeof window !== "undefined" && invite && !done.current) {
        stashInvite(KEY_, invite, opts.ttlDays);
    }

    return useCallback(async (): Promise<InviteClaim> => {
        if (done.current) return { state: "idle" };
        let token = invite;
        if (!token && typeof window !== "undefined") token = readInvite(KEY_);
        if (!token) return { state: "idle" };
        done.current = true;

        try {
            const res = await fetch(ENDPOINT_, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token }),
            });
            const json: any = await res.json().catch(() => ({}));
            if (!res.ok) {
                // A reason code is the server's final word on this token (spent,
                // not new, already invited by someone else): replaying it on every
                // load changes nothing, so it goes. Anything else (no session yet,
                // a 500, a dropped connection) keeps it for the next load.
                const refusal = typeof json.refusal === "string" ? json.refusal : undefined;
                if (refusal) clearInvite(KEY_);
                return { state: "refused", reason: String(json.error ?? `HTTP ${res.status}`), refusal };
            }
            clearInvite(KEY_);
            return { state: "claimed" };
        } catch (e: any) {
            return { state: "refused", reason: e?.message ?? "network" };
        }
    }, [invite, KEY_, ENDPOINT_]);
}
