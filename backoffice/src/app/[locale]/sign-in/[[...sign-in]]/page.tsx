import { SignIn } from "@clerk/nextjs";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { LangToggle } from "@/components/landing/LangToggle";
import { ThemeToggle } from "@/components/ThemeToggle";
import { normalizeReturnSlug, resolveReturnPath } from "@/lib/oauth-return";

export const runtime = "edge";

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
            <div className="flex items-center gap-3 text-xs text-fg-40">
                <Link href="/privacy" className="hover:text-fg-60 transition-colors">
                    {t("privacy")}
                </Link>
                <span className="text-hairline-strong">·</span>
                <Link href="/terms" className="hover:text-fg-60 transition-colors">
                    {t("terms")}
                </Link>
            </div>
        </div>
    );
}
