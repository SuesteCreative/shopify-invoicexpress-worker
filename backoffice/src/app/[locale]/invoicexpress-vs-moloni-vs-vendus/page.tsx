import type { Metadata } from "next";
import { setRequestLocale, getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import JsonLd from "@/components/JsonLd";
import { LegalLinks } from "@/components/LegalLinks";
import { LangToggle } from "@/components/landing/LangToggle";
import { ThemeToggle } from "@/components/ThemeToggle";
import { breadcrumbSchema, faqSchema } from "@/lib/schema";

export const runtime = "edge";

const SITE = "https://rioko.online";
const SLUG = "invoicexpress-vs-moloni-vs-vendus";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { locale } = await params;
    const t = await getTranslations({ locale, namespace: "comparePage.meta" });
    const title = t("title");
    const description = t("description");
    return {
        title,
        description,
        alternates: {
            canonical: `/${locale}/${SLUG}`,
            languages: {
                pt: `/pt/${SLUG}`,
                en: `/en/${SLUG}`,
                "x-default": `/pt/${SLUG}`,
            },
        },
        openGraph: {
            type: "article",
            siteName: "Rioko",
            url: `${SITE}/${locale}/${SLUG}`,
            locale: locale === "pt" ? "pt_PT" : "en_US",
            title,
            description,
        },
        twitter: { card: "summary_large_image", title, description },
    };
}

type Row = {
    feature: string;
    ix: string;
    moloni: string;
    vendus: string;
};

const PROGRAMS = [
    { key: "ix" as const, name: "InvoiceXpress" },
    { key: "moloni" as const, name: "Moloni" },
    { key: "vendus" as const, name: "Vendus" },
];

/**
 * /invoicexpress-vs-moloni-vs-vendus — the comparison a merchant actually
 * searches for before choosing.
 *
 * Deliberately neutral: Rioko integrates with all three, charges the same for
 * each and takes no commission, and the page says so out loud. The table is
 * scoped to what the Rioko integration does with each program, which is what we
 * can state from our own code, rather than to each vendor's full feature
 * catalog, which we cannot keep accurate and have no standing to judge.
 */
export default async function ComparePage({ params }: Props) {
    const { locale } = await params;
    setRequestLocale(locale);

    const t = await getTranslations({ locale, namespace: "comparePage" });
    const rows = t.raw("table.rows") as Row[];
    const faqItems = t.raw("faq.items") as Array<{ q: string; a: string }>;

    return (
        <div className="min-h-screen bg-surface text-fg">
            <JsonLd data={faqSchema(faqItems)} />
            <JsonLd
                data={breadcrumbSchema([
                    { name: t("breadcrumb.home"), url: `${SITE}/${locale}` },
                    { name: t("breadcrumb.page"), url: `${SITE}/${locale}/${SLUG}` },
                ])}
            />

            <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-12 py-10 sm:py-16">
                <div className="mb-12 flex items-center justify-between gap-4">
                    <Link
                        href="/"
                        className="font-mono text-[11px] uppercase tracking-[0.22em] text-fg-40 transition-colors hover:text-fg"
                    >
                        Rioko
                    </Link>
                    <div className="flex items-center gap-2">
                        <ThemeToggle />
                        <LangToggle />
                    </div>
                </div>

                <header className="mb-14">
                    <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.22em] text-fg-40">
                        {t("hero.eyebrow")}
                    </p>
                    <h1 className="text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">
                        {t("hero.h1")}
                    </h1>
                    <p className="mt-5 max-w-3xl text-lg leading-relaxed text-fg-60">
                        {t("hero.sub")}
                    </p>
                    <p className="mt-6 rounded-2xl border border-hairline bg-surface-2 p-4 text-sm leading-relaxed text-fg-40">
                        {t("hero.disclosure")}
                    </p>
                </header>

                <section className="mb-16">
                    <h2 className="text-2xl font-semibold tracking-tight">
                        {t("common.title")}
                    </h2>
                    <p className="mt-4 max-w-3xl leading-relaxed text-fg-60">
                        {t("common.body")}
                    </p>
                    <div className="mt-8 grid gap-5 sm:grid-cols-2">
                        {(["i1", "i2", "i3", "i4"] as const).map((i) => (
                            <div key={i} className="rounded-2xl border border-hairline p-6">
                                <h3 className="font-semibold tracking-tight">
                                    {t(`common.${i}Title`)}
                                </h3>
                                <p className="mt-2 text-sm leading-relaxed text-fg-60">
                                    {t(`common.${i}Body`)}
                                </p>
                            </div>
                        ))}
                    </div>
                </section>

                <section className="mb-16">
                    <h2 className="text-2xl font-semibold tracking-tight">
                        {t("table.title")}
                    </h2>
                    {/* Tables are the one thing allowed to scroll sideways on a
                        phone, but only inside their own container. */}
                    <div className="mt-8 overflow-x-auto rounded-2xl border border-hairline">
                        <table className="w-full min-w-[640px] border-collapse text-sm">
                            <thead>
                                <tr className="border-b border-hairline bg-surface-2">
                                    <th className="p-4 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-fg-40">
                                        {t("table.colFeature")}
                                    </th>
                                    {PROGRAMS.map((p) => (
                                        <th
                                            key={p.key}
                                            className="p-4 text-left font-semibold tracking-tight text-fg"
                                        >
                                            {p.name}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((row) => (
                                    <tr
                                        key={row.feature}
                                        className="border-b border-hairline last:border-0"
                                    >
                                        <th
                                            scope="row"
                                            className="p-4 text-left align-top font-medium text-fg"
                                        >
                                            {row.feature}
                                        </th>
                                        {PROGRAMS.map((p) => (
                                            <td
                                                key={p.key}
                                                className="p-4 align-top leading-relaxed text-fg-60"
                                            >
                                                {row[p.key]}
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <p className="mt-4 text-sm text-fg-40">{t("table.note")}</p>
                </section>

                <section className="mb-16">
                    <h2 className="text-2xl font-semibold tracking-tight">
                        {t("choose.title")}
                    </h2>
                    <div className="mt-8 space-y-5">
                        {(["c1", "c2", "c3", "c4"] as const).map((c) => (
                            <div key={c} className="rounded-2xl border border-hairline p-6">
                                <h3 className="font-semibold tracking-tight">
                                    {t(`choose.${c}Title`)}
                                </h3>
                                <p className="mt-2 leading-relaxed text-fg-60">
                                    {t(`choose.${c}Body`)}
                                </p>
                            </div>
                        ))}
                    </div>
                </section>

                <section className="mb-16 rounded-[2rem] border border-hairline bg-surface-2 p-7 sm:p-10">
                    <h2 className="text-2xl font-semibold tracking-tight">
                        {t("rioko.title")}
                    </h2>
                    <p className="mt-4 max-w-3xl leading-relaxed text-fg-60">
                        {t("rioko.body")}
                    </p>
                    <Link
                        href="/#integracoes"
                        className="mt-6 inline-block font-mono text-[12px] uppercase tracking-[0.14em] text-accent-ink underline underline-offset-4"
                    >
                        {t("rioko.cta")}
                    </Link>
                </section>

                <section className="mb-16">
                    <h2 className="text-2xl font-semibold tracking-tight">
                        {t("faq.title")}
                    </h2>
                    <div className="mt-8 space-y-5">
                        {faqItems.map((item) => (
                            <div key={item.q} className="rounded-2xl border border-hairline p-6">
                                <h3 data-faq-question className="font-semibold tracking-tight">
                                    {item.q}
                                </h3>
                                <p
                                    data-faq-answer
                                    className="mt-2 leading-relaxed text-fg-60"
                                >
                                    {item.a}
                                </p>
                            </div>
                        ))}
                    </div>
                </section>

                <section className="rounded-[2rem] border border-accent/30 bg-accent/5 p-8 text-center sm:p-12">
                    <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                        {t("cta.title")}
                    </h2>
                    <p className="mx-auto mt-3 max-w-xl text-fg-60">{t("cta.body")}</p>
                    <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                        <Link
                            href="/sign-up"
                            className="rounded-xl bg-accent px-5 py-3 font-mono text-[12px] uppercase tracking-[0.14em] text-white transition-colors hover:bg-accent-hot hover:text-surface"
                        >
                            {t("cta.start")}
                        </Link>
                        <Link
                            href="/pricing"
                            className="rounded-xl border border-rule px-5 py-3 font-mono text-[12px] uppercase tracking-[0.14em] text-fg transition-colors hover:border-accent/40"
                        >
                            {t("cta.pricing")}
                        </Link>
                    </div>
                </section>

                <footer className="mt-20 flex flex-wrap items-center justify-center gap-3 border-t border-hairline pt-8 text-xs text-fg-40">
                    <LegalLinks className="transition-colors hover:text-fg-60" />
                </footer>
            </div>
        </div>
    );
}
