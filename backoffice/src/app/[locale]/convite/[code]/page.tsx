import type { Metadata } from "next";
import { Suspense } from "react";
import { setRequestLocale } from "next-intl/server";
import { ReferralLanding } from "@/components/ReferralLanding";

export const runtime = "edge";

/**
 * Where a referral link lands.
 *
 * Public, because the person holding it has no account yet — that is the whole
 * point of the link. The code carries no authority here: the page stashes it and
 * hands it to the server once there is a session, and the server decides whether
 * it is worth anything.
 *
 * Metadata is declared here as an OBJECT, never a metadata FILE: a metadata file
 * anywhere under `[locale]` becomes a route that next-on-pages refuses, and the
 * Pages build fails without `next build` saying a word.
 */
export const metadata: Metadata = {
    title: "Convite Rioko",
    robots: { index: false, follow: false },
    icons: {
        icon: [{ url: "/images/rioko-badge.png", type: "image/png", sizes: "96x96" }],
        apple: [{ url: "/images/rioko-badge-180.png", sizes: "180x180" }],
    },
};

export default async function ReferralInvitePage({
    params,
}: {
    params: Promise<{ locale: string; code: string }>;
}) {
    const { locale, code } = await params;
    setRequestLocale(locale);
    return (
        <Suspense>
            <ReferralLanding code={code} locale={locale} />
        </Suspense>
    );
}
