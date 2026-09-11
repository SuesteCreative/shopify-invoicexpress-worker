import type { Metadata } from "next";
import { Suspense } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import LodgifyOnboarding from "@/components/onboarding/LodgifyOnboarding";

export const runtime = "edge";

/**
 * The Lodgify → Moloni onboarding a client is sent a link to.
 *
 * Same six steps as its InvoiceXpress sibling on the same component; only the
 * fourth step differs, because Moloni is authorised through OAuth instead of a
 * pasted key.
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
        title: t("titleMoloni"),
        description: t("descriptionMoloni"),
        robots: { index: false, follow: false },
        icons: {
            icon: [{ url: "/images/rioko-badge.png", type: "image/png", sizes: "96x96" }],
            apple: [{ url: "/images/rioko-badge-180.png", sizes: "180x180" }],
        },
        alternates: {
            canonical: `/${locale}/onboarding/lodgify-moloni`,
            languages: {
                pt: "/pt/onboarding/lodgify-moloni",
                en: "/en/onboarding/lodgify-moloni",
            },
        },
    };
}

export default async function LodgifyMoloniOnboardingPage({
    params,
}: {
    params: Promise<{ locale: string }>;
}) {
    const { locale } = await params;
    setRequestLocale(locale);
    return (
        <Suspense>
            <LodgifyOnboarding destination="moloni" />
        </Suspense>
    );
}
