import * as React from "react";
import { setRequestLocale, getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { LangToggle } from "@/components/landing/LangToggle";
import { ThemeToggle } from "@/components/ThemeToggle";

export const runtime = "edge";

export async function generateMetadata({
    params,
}: {
    params: Promise<{ locale: string }>;
}) {
    const { locale } = await params;
    const t = await getTranslations({ locale, namespace: "metadata" });
    return { title: t("privacyTitle") };
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

/** The footers link straight to the consumer/dispute-resolution section, so that
 *  one needs a name that survives the sections being renumbered. */
const ANCHORS: Record<string, string> = { s10: "litigios" };

export default async function PrivacyPage({
    params,
}: {
    params: Promise<{ locale: string }>;
}) {
    const { locale } = await params;
    setRequestLocale(locale);
    const t = await getTranslations("privacy");

    const sections = [
        "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11",
    ] as const;

    return (
        <div className="min-h-screen bg-background text-fg">
            <div className="mx-auto max-w-3xl px-6 py-16">
                <div className="flex items-center justify-between gap-4">
                    <Link
                        href="/"
                        className="text-sm text-fg-60 hover:text-fg transition"
                    >
                        {t("back")}
                    </Link>
                    <div className="flex items-center gap-2">
                        <ThemeToggle />
                        <LangToggle />
                    </div>
                </div>

                <h1 className="mt-8 text-4xl font-black text-fg">
                    {t("title")}
                </h1>
                <p className="mt-2 text-sm text-fg-40">{t("lastUpdate")}</p>

                <div className="mt-10 space-y-8">
                    {sections.map((s) => (
                        <section key={s} id={ANCHORS[s] ?? s} className="scroll-mt-8">
                            <h2 className="text-xl font-bold text-fg">
                                {t(`${s}.title`)}
                            </h2>
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
