import type { Metadata } from "next";
import { Suspense } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import ConnectMoloniOnboarding from "@/components/onboarding/ConnectMoloniOnboarding";

export const runtime = "edge";

/**
 * The Stripe Connect → Moloni onboarding a client is sent a link to.
 *
 * Public, because the first step is creating the account. Everything after that
 * is behind the same endpoints as the dashboard wizard, which answer 401 without
 * a session, so nothing here is reachable for an anonymous visitor beyond the
 * copy itself.
 *
 * noindex: it is a link handed to one merchant, not a page to be found.
 */
export async function generateMetadata({
    params,
}: {
    params: Promise<{ locale: string }>;
}): Promise<Metadata> {
    const { locale } = await params;
    const t = await getTranslations({ locale, namespace: "connectOnboarding.meta" });
    return {
        title: t("title"),
        description: t("description"),
        robots: { index: false, follow: false },
        // The badge, not the app's usual mark: a client leaves this tab open
        // through six steps, Stripe and Moloni, and it is what they find their
        // way back to. Declared here rather than as an `icon.png` beside the
        // page: inside `[locale]` that file becomes a route, and next-on-pages
        // refuses any route that is not on the edge — which is what failed the
        // last two Pages builds.
        icons: {
            icon: [{ url: "/images/rioko-badge.png", type: "image/png", sizes: "96x96" }],
            apple: [{ url: "/images/rioko-badge-180.png", sizes: "180x180" }],
        },
        alternates: {
            canonical: `/${locale}/onboarding/stripe-connect-moloni`,
            languages: {
                pt: "/pt/onboarding/stripe-connect-moloni",
                en: "/en/onboarding/stripe-connect-moloni",
            },
        },
    };
}

export default async function ConnectMoloniOnboardingPage({
    params,
}: {
    params: Promise<{ locale: string }>;
}) {
    const { locale } = await params;
    setRequestLocale(locale);
    return (
        <Suspense>
            <ConnectMoloniOnboarding />
        </Suspense>
    );
}
