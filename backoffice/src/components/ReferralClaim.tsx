"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { AlertCircle, Check, X } from "lucide-react";
import { useOnboardingInvite, type InviteClaim } from "@/lib/use-onboarding-invite";
import { NEW_ACCOUNT_WINDOW_DAYS, REWARD_MONTHS } from "@/lib/referral";

/** Shared with ReferralLanding, which stashes what this spends. */
export const REFERRAL_INVITE = {
    key: "rioko_referral_code",
    endpoint: "/api/referral/claim",
    // As long as an account counts as new. A link opened longer ago than that
    // is not worth carrying into a sign-up.
    ttlDays: NEW_ACCOUNT_WINDOW_DAYS,
};

/**
 * Claims a referral once the visitor has an account, wherever they end up.
 *
 * Mounted in the locale layout beside AttributionCapture, and for the same
 * reason: the code is picked up on a public page, the account is created several
 * redirects later, and nothing in between is under our control. Clerk's sign-up
 * sends people to a path from a fixed map, never one from a query string, so the
 * code cannot ride along in the URL — it waits in localStorage, because the
 * sign-up often finishes in another tab, and is spent on the first authenticated
 * render after.
 *
 * The answer is shown, once, and can be put away. It used to be silent, on the
 * theory that a refused code was not the visitor's problem, but a friend who
 * signed up counting on two free months only found out at checkout, when the
 * trial was not there. A transient failure (no session yet, a 500, the network)
 * still says nothing and tries again on the next load: only the server's final
 * word is worth a notice.
 *
 * Not on the invite page itself: it claims and answers in place, and a second
 * notice over it would say the same thing twice.
 */
export default function ReferralClaim() {
    const t = useTranslations("referral");
    const { isLoaded, isSignedIn } = useAuth();
    const onInvitePage = /\/convite\//.test(usePathname() ?? "");
    const claim = useOnboardingInvite(undefined, REFERRAL_INVITE);
    const [notice, setNotice] = useState<InviteClaim | null>(null);

    useEffect(() => {
        if (!isLoaded || !isSignedIn || onInvitePage) return;
        void claim().then((r) => {
            if (r.state === "claimed" || (r.state === "refused" && r.refusal)) setNotice(r);
        });
    }, [isLoaded, isSignedIn, onInvitePage, claim]);

    if (!notice || notice.state === "idle") return null;
    const refused = notice.state === "refused";

    return (
        <div
            role={refused ? "alert" : "status"}
            className="fixed top-4 inset-x-4 sm:inset-x-auto sm:right-6 sm:w-[24rem] z-[80] glass rounded-2xl border border-hairline p-4 flex items-start gap-3"
        >
            <div className="shrink-0 mt-0.5">
                {refused
                    ? <AlertCircle className="w-4 h-4 text-soon" />
                    : <Check className="w-4 h-4 text-accent-ink" />}
            </div>
            <div className="min-w-0 flex-1 space-y-1">
                {refused ? (
                    <>
                        <p className="text-sm font-medium text-fg">{t("refusedNoticeTitle")}</p>
                        <p className="text-xs text-fg-60">{notice.reason}</p>
                    </>
                ) : (
                    <p className="text-sm font-medium text-fg">{t("claimedNotice", { months: REWARD_MONTHS })}</p>
                )}
            </div>
            <button type="button" onClick={() => setNotice(null)} aria-label={t("noticeDismiss")}
                className="shrink-0 p-1.5 rounded-lg text-fg-40 hover:text-fg hover:bg-fg/5 transition-colors">
                <X className="w-4 h-4" />
            </button>
        </div>
    );
}
