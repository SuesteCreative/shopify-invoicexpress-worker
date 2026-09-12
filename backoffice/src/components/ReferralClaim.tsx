"use client";

import { useEffect } from "react";
import { useAuth } from "@clerk/nextjs";
import { useOnboardingInvite } from "@/lib/use-onboarding-invite";

export const REFERRAL_KEY = "rioko_referral_code";

/**
 * Claims a referral once the visitor has an account, wherever they end up.
 *
 * Mounted in the locale layout beside AttributionCapture, and for the same
 * reason: the code is picked up on a public page, the account is created several
 * redirects later, and nothing in between is under our control. Clerk's sign-up
 * sends people to a path from a fixed map, never one from a query string, so the
 * code cannot ride along in the URL — it waits in sessionStorage and is spent on
 * the first authenticated render after.
 *
 * Silent by design. A spent, expired or self-issued code is not the visitor's
 * problem to read about on their first screen; the server has already refused
 * it, and their account works either way.
 */
export default function ReferralClaim() {
    const { isLoaded, isSignedIn } = useAuth();
    const claim = useOnboardingInvite(undefined, {
        key: REFERRAL_KEY,
        endpoint: "/api/referral/claim",
    });

    useEffect(() => {
        if (!isLoaded || !isSignedIn) return;
        void claim();
    }, [isLoaded, isSignedIn, claim]);

    return null;
}
