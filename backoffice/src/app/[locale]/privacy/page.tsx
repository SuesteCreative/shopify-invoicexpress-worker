import * as React from "react";
import { setRequestLocale, getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

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
        <a href={`mailto:${String(chunks)}`} className="text-sky-400 underline">
            {chunks}
        </a>
    ),
    site: (chunks: React.ReactNode) => (
        <a
            href={`https://${String(chunks)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sky-400 underline"
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

export default async function PrivacyPage({
    params,
}: {
    params: Promise<{ locale: string }>;
}) {
    const { locale } = await params;
    setRequestLocale(locale);
    const t = await getTranslations("privacy");

    const sections = [
        "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10",
    ] as const;

    return (
        <div className="min-h-screen bg-slate-950 text-slate-200">
            <div className="mx-auto max-w-3xl px-6 py-16">
                <Link
                    href="/"
                    className="text-sm text-slate-400 hover:text-slate-200 transition"
                >
                    {t("back")}
                </Link>

                <h1 className="mt-8 text-4xl font-black text-white">
                    {t("title")}
                </h1>
                <p className="mt-2 text-sm text-slate-500">{t("lastUpdate")}</p>

                <div className="mt-10 space-y-8">
                    {sections.map((s) => (
                        <section key={s}>
                            <h2 className="text-xl font-bold text-white">
                                {t(`${s}.title`)}
                            </h2>
                            <div className="mt-3 text-slate-300 leading-relaxed text-[15px]">
                                {t.rich(`${s}.body`, LEGAL_RICH)}
                            </div>
                        </section>
                    ))}
                </div>
            </div>
        </div>
    );
}
