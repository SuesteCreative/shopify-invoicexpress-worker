import { SignUp } from "@clerk/nextjs";
import { getTranslations } from "next-intl/server";
import { LangToggle } from "@/components/landing/LangToggle";
import { ThemeToggle } from "@/components/ThemeToggle";
import { normalizeReturnSlug, resolveReturnPath } from "@/lib/oauth-return";
import { LegalLinks } from "@/components/LegalLinks";

export const runtime = "edge";

export default async function Page({
    params,
    searchParams,
}: {
    params: Promise<{ locale: string }>;
    searchParams: Promise<{ onboarding?: string }>;
}) {
    const { locale } = await params;
    // A guided onboarding page sends the merchant here to sign up and expects
    // them back on the step they left. Resolved from a fixed map of slugs, never
    // from a path in the query string, and the dashboard is what anything else
    // gets.
    const onboarding = normalizeReturnSlug((await searchParams).onboarding);
    const afterSignUp = onboarding
        ? resolveReturnPath(onboarding, locale)
        : `/${locale}/dashboard`;
    const t = await getTranslations({ locale, namespace: "landing.footer" });
    return (
        <div className="flex flex-col items-center justify-center min-h-screen gap-6 bg-background p-4">
            <div className="flex items-center gap-2">
                <ThemeToggle />
                <LangToggle />
            </div>
            <div className="w-full max-w-[440px] flex justify-center">
                <SignUp
                    path={`/${locale}/sign-up`}
                    signInUrl={onboarding ? `/${locale}/sign-in?onboarding=${onboarding}` : `/${locale}/sign-in`}
                    forceRedirectUrl={afterSignUp}
                    appearance={{
                        layout: {
                            logoImageUrl: "/images/rioko2-logo-light2.svg",
                            logoPlacement: "inside",
                        },
                        elements: {
                            logoImage: "h-7 w-auto",
                        },
                    }}
                />
            </div>
            <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-fg-40">
                <LegalLinks className="hover:text-fg-60 transition-colors" />
            </div>
        </div>
    );
}
