"use client";

import { useEffect } from "react";
import { useAuth } from "@clerk/nextjs";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Gift, Check } from "lucide-react";
import { useOnboardingInvite } from "@/lib/use-onboarding-invite";
import { REFERRAL_KEY } from "@/components/ReferralClaim";
import { LegalLinks } from "@/components/LegalLinks";

/**
 * The page a referral link opens.
 *
 * Its only job is to stash the code before the visitor goes anywhere, which
 * happens on the first render, and then get out of the way. Someone already
 * signed in has it claimed here and now; everybody else claims it after sign-up,
 * from the layout, because Clerk decides where they land and it is never here.
 */
export function ReferralLanding({ code, locale }: { code: string; locale: string }) {
    const t = useTranslations("referral");
    const { isLoaded, isSignedIn } = useAuth();
    const claim = useOnboardingInvite(code, { key: REFERRAL_KEY, endpoint: "/api/referral/claim" });

    useEffect(() => {
        if (!isLoaded || !isSignedIn) return;
        void claim();
    }, [isLoaded, isSignedIn, claim]);

    return (
        <div className="min-h-screen flex flex-col items-center justify-center p-6">
            <div className="glass rounded-[2rem] border-hairline p-7 sm:p-10 max-w-lg w-full space-y-6">
                <div className="flex items-center gap-3">
                    <span className="w-10 h-10 rounded-2xl bg-accent/18 border border-accent/45 flex items-center justify-center">
                        <Gift className="w-5 h-5 text-accent-ink" />
                    </span>
                    <span className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">
                        {t("landingBadge")}
                    </span>
                </div>

                <div className="space-y-3">
                    <h1 className="text-2xl sm:text-3xl font-medium tracking-tight text-fg">
                        {t("landingTitle")}
                    </h1>
                    <p className="text-sm text-fg-60 leading-relaxed">{t("landingSubtitle")}</p>
                </div>

                <ul className="space-y-2">
                    {["landingBenefit1", "landingBenefit2", "landingBenefit3"].map((k) => (
                        <li key={k} className="flex items-start gap-2 text-sm text-fg-60">
                            <Check className="w-4 h-4 text-accent-ink shrink-0 mt-0.5" />
                            {t(k)}
                        </li>
                    ))}
                </ul>

                {isSignedIn ? (
                    <div className="space-y-2">
                        <p className="text-sm text-fg">{t("landingAlreadyIn")}</p>
                        <Link
                            href="/dashboard"
                            className="inline-flex px-5 py-2.5 rounded-xl text-sm font-medium bg-fg text-surface hover:bg-accent hover:text-on-accent transition-all"
                        >
                            {t("landingGoToDashboard")}
                        </Link>
                    </div>
                ) : (
                    <a
                        href={`/${locale}/sign-up`}
                        className="inline-flex px-5 py-2.5 rounded-xl text-sm font-medium bg-fg text-surface hover:bg-accent hover:text-on-accent transition-all"
                    >
                        {t("landingCta")}
                    </a>
                )}

                <p className="text-[11px] text-fg-40 leading-snug border-t border-hairline pt-4">
                    {t("landingTerms")}
                </p>

                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-fg-40">
                    <LegalLinks className="hover:text-fg-60 transition-colors" />
                </div>
            </div>
        </div>
    );
}
