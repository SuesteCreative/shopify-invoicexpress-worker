import type { Metadata } from "next";
import { Suspense } from "react";
import { setRequestLocale } from "next-intl/server";
import ConnectMoloniOnboarding from "@/components/onboarding/ConnectMoloniOnboarding";

export const runtime = "edge";

/**
 * The same onboarding as /stripe-connect-moloni, reached through an invite handed to one client.
 *
 * The extra segment is the invite token. It carries no authority here: the page
 * hands it to the component, which claims it against the server once there is a
 * session, and the server decides whether it is worth anything.
 *
 * Metadata is declared here rather than borrowed from the page above, and it is
 * deliberately a metadata OBJECT: a metadata FILE anywhere under `[locale]`
 * becomes a route that next-on-pages refuses, and the Pages build fails without
 * `next build` saying a word.
 */
export const metadata: Metadata = {
    title: "Rioko",
    robots: { index: false, follow: false },
    icons: {
        icon: [{ url: "/images/rioko-badge.png", type: "image/png", sizes: "96x96" }],
        apple: [{ url: "/images/rioko-badge-180.png", sizes: "180x180" }],
    },
};

export default async function InvitedOnboardingPage({
    params,
}: {
    params: Promise<{ locale: string; invite: string }>;
}) {
    const { locale, invite } = await params;
    setRequestLocale(locale);
    return (
        <Suspense>
            <ConnectMoloniOnboarding invite={invite} />
        </Suspense>
    );
}
