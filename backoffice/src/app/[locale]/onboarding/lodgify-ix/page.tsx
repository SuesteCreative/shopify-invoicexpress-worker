import type { Metadata } from "next";
import { Suspense } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import LodgifyOnboarding from "@/components/onboarding/LodgifyOnboarding";

export const runtime = "edge";

/**
 * The Lodgify → InvoiceXpress onboarding a client is sent a link to.
 *
 * Public, because the first step is creating the account. Everything after that
 * is behind the same endpoints as the dashboard wizard, which answer 401
 * without a session.
 *
 * noindex: it is a link handed to one merchant, not a page to be found.
 */
export async function generateMetadata({
    params,
}: {
    params: Promise<{ locale: string }>;
}): Promise<Metadata> {
    const { locale } = await params;
    const t = await getTranslations({ locale, namespace: "lodgifyOnboarding.meta" });
    return {
        title: t("titleIx"),
        description: t("descriptionIx"),
        robots: { index: false, follow: false },
        icons: {
            icon: [{ url: "/images/rioko-badge.png", type: "image/png", sizes: "96x96" }],
            apple: [{ url: "/images/rioko-badge-180.png", sizes: "180x180" }],
        },
        alternates: {
            canonical: `/${locale}/onboarding/lodgify-ix`,
            languages: {
                pt: "/pt/onboarding/lodgify-ix",
                en: "/en/onboarding/lodgify-ix",
            },
        },
    };
}

export default async function LodgifyIxOnboardingPage({
    params,
}: {
    params: Promise<{ locale: string }>;
}) {
    const { locale } = await params;
    setRequestLocale(locale);
    return (
        <Suspense>
            <LodgifyOnboarding destination="invoicexpress" />
        </Suspense>
    );
}
