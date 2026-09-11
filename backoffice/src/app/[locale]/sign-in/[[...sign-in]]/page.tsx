import type { Metadata } from "next";
import { SignIn } from "@clerk/nextjs";
import { getTranslations } from "next-intl/server";
import { LangToggle } from "@/components/landing/LangToggle";
import { ThemeToggle } from "@/components/ThemeToggle";
import { normalizeReturnSlug, resolveReturnPath } from "@/lib/oauth-return";
import { LegalLinks } from "@/components/LegalLinks";

export const runtime = "edge";

// Auth screens carry nothing worth ranking, and an indexed sign-in page
// competes with the landing page for the brand query. robots.txt alone does not
// settle it — a disallowed URL can still be indexed from links, just without a
// snippet — so say noindex on the page itself.
export const metadata: Metadata = { robots: { index: false, follow: false } };


export default async function Page({
    params,
    searchParams,
}: {
    params: Promise<{ locale: string }>;
    searchParams: Promise<{ onboarding?: string }>;
}) {
    const { locale } = await params;
    // A merchant who already has an account arrives here from a guided
    // onboarding page, and has to come back to the step they left. A fixed map
    // of slugs, never a path from the query string.
    const onboarding = normalizeReturnSlug((await searchParams).onboarding);
    const afterSignIn = onboarding
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
                <SignIn
                    path={`/${locale}/sign-in`}
                    signUpUrl={onboarding ? `/${locale}/sign-up?onboarding=${onboarding}` : `/${locale}/sign-up`}
                    forceRedirectUrl={afterSignIn}
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
