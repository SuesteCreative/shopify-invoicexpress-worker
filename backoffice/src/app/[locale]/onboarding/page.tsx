import type { Metadata } from "next";
import { Suspense } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import GeneralOnboarding from "@/components/onboarding/GeneralOnboarding";

export const runtime = "edge";

/**
 * The onboarding every new client lands on after signing up.
 *
 * It asks the two things nothing else can start without: who they are for tax
 * purposes, and which two platforms they want joined. Then it hands them over
 * — to the guided page for that pair when one exists, to the dashboard when it
 * does not. The pairs that have their own page are listed in one place,
 * src/lib/platforms.ts, so the day a Shopify onboarding exists this page starts
 * routing to it without being touched.
 *
 * Public, like its siblings under /onboarding: the first step is creating the
 * account. Every endpoint it calls still answers 401 without a session.
 */
export async function generateMetadata({
    params,
}: {
    params: Promise<{ locale: string }>;
}): Promise<Metadata> {
    const { locale } = await params;
    const t = await getTranslations({ locale, namespace: "generalOnboarding.meta" });
    return {
        title: t("title"),
        description: t("description"),
        robots: { index: false, follow: false },
        icons: {
            icon: [{ url: "/images/rioko-badge.png", type: "image/png", sizes: "96x96" }],
            apple: [{ url: "/images/rioko-badge-180.png", sizes: "180x180" }],
        },
        alternates: {
            canonical: `/${locale}/onboarding`,
            languages: {
                pt: "/pt/onboarding",
                en: "/en/onboarding",
            },
        },
    };
}

export default async function GeneralOnboardingPage({
    params,
}: {
    params: Promise<{ locale: string }>;
}) {
    const { locale } = await params;
    setRequestLocale(locale);
    return (
        <Suspense>
            <GeneralOnboarding />
        </Suspense>
    );
}
