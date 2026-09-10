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
