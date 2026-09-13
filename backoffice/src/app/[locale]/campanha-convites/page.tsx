import * as React from "react";
import { setRequestLocale, getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { LangToggle } from "@/components/landing/LangToggle";
import { ThemeToggle } from "@/components/ThemeToggle";
import { campaignOpen } from "@/lib/referral";

export const runtime = "edge";

/**
 * The campaign terms.
 *
 * Deliberately NOT in LegalLinks: privacy and terms are permanent, this expires.
 * After 31 October it is delisted rather than deleted — it drops out of the
 * sitemap and out of search, and says so at the top, but the URL keeps answering.
 * Somebody who took part has the right to reread what they agreed to, and we
 * need to be able to show it.
 *
 * The date comes from lib/referral, the same constant the server uses to refuse
 * a claim, so the page and the rule cannot disagree.
 *
 * Metadata as an OBJECT, never a metadata FILE: a metadata file anywhere under
 * `[locale]` becomes a route next-on-pages refuses, and the Pages build fails
 * without `next build` saying a word.
 */
export async function generateMetadata({
    params,
}: {
    params: Promise<{ locale: string }>;
}) {
    const { locale } = await params;
    const t = await getTranslations({ locale, namespace: "campanhaConvites" });
    const open = campaignOpen();
    return {
        title: t("metaTitle"),
        description: t("metaDescription"),
        // Once the campaign is over the page stops competing for anything and
        // stops being an offer a crawler can still surface.
        robots: open ? undefined : { index: false, follow: false },
        alternates: {
            canonical: `/${locale}/campanha-convites`,
            languages: {
                pt: "/pt/campanha-convites",
                en: "/en/campanha-convites",
                "x-default": "/pt/campanha-convites",
            },
        },
    };
}

const LEGAL_RICH = {
    b: (chunks: React.ReactNode) => <strong>{chunks}</strong>,
    mail: (chunks: React.ReactNode) => (
        <a href={`mailto:${String(chunks)}`} className="text-accent-ink underline">
            {chunks}
        </a>
    ),
    site: (chunks: React.ReactNode) => (
        <a
            href={`https://${String(chunks)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-ink underline"
        >
            {chunks}
        </a>
    ),
    br: () => <br />,
    p: (chunks: React.ReactNode) => <p className="mt-3">{chunks}</p>,
    ul: (chunks: React.ReactNode) => (
        <ul className="list-disc pl-6 space-y-1 mt-2">{chunks}</ul>
    ),
    li: (chunks: React.ReactNode) => <li>{chunks}</li>,
} as const;

export default async function CampanhaConvitesPage({
    params,
}: {
    params: Promise<{ locale: string }>;
}) {
    const { locale } = await params;
    setRequestLocale(locale);
    const t = await getTranslations("campanhaConvites");
    const open = campaignOpen();

    const sections = [
        "s1", "s2", "s3", "s4", "s5", "s6", "s7",
        "s8", "s9", "s10", "s11", "s12", "s13",
    ] as const;

    return (
        <div className="min-h-screen bg-background text-fg">
            <div className="mx-auto max-w-3xl px-6 py-16">
                <div className="flex items-center justify-between gap-4">
                    <Link href="/" className="text-sm text-fg-60 hover:text-fg transition">
                        {t("back")}
                    </Link>
                    <div className="flex items-center gap-2">
                        <ThemeToggle />
                        <LangToggle />
                    </div>
                </div>

                <h1 className="mt-8 text-4xl font-black text-fg">{t("title")}</h1>
                <p className="mt-2 text-sm text-fg-40">{t("lastUpdate")}</p>

                {!open && (
                    <p className="mt-6 rounded-2xl border border-hairline bg-surface-2 px-5 py-4 text-sm text-fg-60">
                        {t("ended")}
                    </p>
                )}

                <div className="mt-10 space-y-8">
                    {sections.map((s) => (
                        <section key={s}>
                            <h2 className="text-xl font-bold text-fg">{t(`${s}.title`)}</h2>
                            <div className="mt-3 text-fg-60 leading-relaxed text-[15px]">
                                {t.rich(`${s}.body`, LEGAL_RICH)}
                            </div>
                        </section>
                    ))}
                </div>
            </div>
        </div>
    );
}
