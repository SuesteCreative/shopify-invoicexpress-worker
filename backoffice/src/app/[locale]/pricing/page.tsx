import type { Metadata } from "next";
import { setRequestLocale, getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Check } from "lucide-react";
import JsonLd from "@/components/JsonLd";
import { LegalLinks } from "@/components/LegalLinks";
import { SiteLinks } from "@/components/SiteLinks";
import { LangToggle } from "@/components/landing/LangToggle";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
    breadcrumbSchema,
    faqSchema,
    softwareApplicationSchema,
} from "@/lib/schema";

export const runtime = "edge";

const SITE = "https://rioko.online";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { locale } = await params;
    const t = await getTranslations({ locale, namespace: "pricingPage.meta" });
    const title = t("title");
    const description = t("description");
    return {
        title,
        description,
        alternates: {
            canonical: `/${locale}/pricing`,
            languages: {
                pt: "/pt/pricing",
                en: "/en/pricing",
                "x-default": "/pt/pricing",
            },
        },
        openGraph: {
            type: "website",
            siteName: "Rioko",
            url: `${SITE}/${locale}/pricing`,
            locale: locale === "pt" ? "pt_PT" : "en_US",
            title,
            description,
        },
        twitter: { card: "summary_large_image", title, description },
    };
}

const TIERS = ["monthly", "yearly", "custom"] as const;
const BULLETS = ["b1", "b2", "b3", "b4", "b5"] as const;

/**
 * /pricing — a page of its own, not the `#preco` anchor it used to be.
 *
 * "How much does it cost" is one of the highest-intent queries there is, and an
 * anchor on the landing page cannot rank for it or be cited on its own. Server
 * component on purpose: no interactivity here worth shipping JS for, and the
 * crawlers that matter most do not execute it anyway.
 */
export default async function PricingPage({ params }: Props) {
    const { locale } = await params;
    setRequestLocale(locale);

    const t = await getTranslations({ locale, namespace: "pricingPage" });
    const faqItems = t.raw("faq.items") as Array<{ q: string; a: string }>;

    return (
        <div className="min-h-screen bg-surface text-fg">
            <JsonLd data={softwareApplicationSchema(locale)} />
            <JsonLd data={faqSchema(faqItems)} />
            <JsonLd
                data={breadcrumbSchema([
                    { name: t("breadcrumb.home"), url: `${SITE}/${locale}` },
                    { name: t("breadcrumb.page"), url: `${SITE}/${locale}/pricing` },
                ])}
            />

            <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-12 py-10 sm:py-16">
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

                <header className="mb-16 text-center">
                    <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.22em] text-fg-40">
                        {t("hero.eyebrow")}
                    </p>
                    <h1 className="text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">
                        {t("hero.h1")}
                    </h1>
                    <p className="mx-auto mt-5 max-w-2xl leading-relaxed text-fg-60">
                        {t("hero.sub")}
                    </p>
                    <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.14em] text-fg-40">
                        {t("hero.notice")}
                    </p>
                </header>

                <section className="grid gap-6 md:grid-cols-3">
                    {TIERS.map((tier) => {
                        const featured = tier === "yearly";
                        return (
                            <div
                                key={tier}
                                className={`glass flex flex-col rounded-[2rem] border p-7 ${
                                    featured
                                        ? "border-accent/40 bg-accent/5"
                                        : "border-hairline"
                                }`}
                            >
                                <div className="flex items-baseline justify-between gap-3">
                                    <h2 className="text-lg font-semibold tracking-tight">
                                        {t(`tiers.${tier}.name`)}
                                    </h2>
                                    {featured && (
                                        <span className="rounded-md border border-accent/30 bg-accent/10 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-accent-ink">
                                            {t("tiers.yearly.badge")}
                                        </span>
                                    )}
                                </div>

                                <p className="mt-6 text-4xl font-bold tracking-tight">
                                    {t(`tiers.${tier}.price`)}
                                </p>
                                <p className="mt-2 text-sm leading-relaxed text-fg-60">
                                    {t(`tiers.${tier}.period`)}
                                </p>

                                <ul className="mt-7 flex-1 space-y-3">
                                    {BULLETS.map((b) => (
                                        <li key={b} className="flex gap-2.5 text-sm text-fg-60">
                                            <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent-ink" />
                                            <span>{t(`tiers.${tier}.${b}`)}</span>
                                        </li>
                                    ))}
                                </ul>

                                <Link
                                    href={tier === "custom" ? "/#faq" : "/sign-up"}
                                    className={`mt-8 rounded-xl px-4 py-3 text-center font-mono text-[12px] uppercase tracking-[0.14em] transition-colors ${
                                        featured
                                            ? "bg-accent text-white hover:bg-accent-hot hover:text-surface"
                                            : "border border-rule text-fg hover:border-accent/40"
                                    }`}
                                >
                                    {t(`tiers.${tier}.cta`)}
                                </Link>
                            </div>
                        );
                    })}
                </section>

                <section className="mt-20 rounded-[2rem] border border-hairline p-7 sm:p-10">
                    <h2 className="text-2xl font-semibold tracking-tight">
                        {t("counts.title")}
                    </h2>
                    <p className="mt-4 max-w-3xl leading-relaxed text-fg-60">
                        {t("counts.body")}
                    </p>
                    <dl className="mt-8 grid gap-5 sm:grid-cols-3">
                        {(["ex1", "ex2", "ex3"] as const).map((ex) => (
                            <div
                                key={ex}
                                className="rounded-2xl border border-hairline bg-surface-2 p-5"
                            >
                                <dt className="font-mono text-[10px] uppercase tracking-[0.18em] text-fg-40">
                                    {t(`counts.${ex}Label`)}
                                </dt>
                                <dd className="mt-2 text-sm text-fg">
                                    {t(`counts.${ex}Value`)}
                                </dd>
                            </div>
                        ))}
                    </dl>
                    <p className="mt-6 text-sm text-fg-40">{t("counts.note")}</p>
                </section>

                <section className="mt-20">
                    <h2 className="text-2xl font-semibold tracking-tight">
                        {t("included.title")}
                    </h2>
                    <div className="mt-8 grid gap-6 sm:grid-cols-2">
                        {(["i1", "i2", "i3", "i4"] as const).map((i) => (
                            <div
                                key={i}
                                className="rounded-2xl border border-hairline p-6"
                            >
                                <h3 className="font-semibold tracking-tight">
                                    {t(`included.${i}Title`)}
                                </h3>
                                <p className="mt-2 text-sm leading-relaxed text-fg-60">
                                    {t(`included.${i}Body`)}
                                </p>
                            </div>
                        ))}
                    </div>
                </section>

                <section className="mt-20">
                    <h2 className="text-2xl font-semibold tracking-tight">
                        {t("faq.title")}
                    </h2>
                    <div className="mt-8 space-y-5">
                        {faqItems.map((item) => (
                            <div
                                key={item.q}
                                className="rounded-2xl border border-hairline p-6"
                            >
                                <h3
                                    data-faq-question
                                    className="font-semibold tracking-tight"
                                >
                                    {item.q}
                                </h3>
                                <p
                                    data-faq-answer
                                    className="mt-2 text-sm leading-relaxed text-fg-60"
                                >
                                    {item.a}
                                </p>
                            </div>
                        ))}
                    </div>
                </section>

                <section className="mt-20 rounded-[2rem] border border-accent/30 bg-accent/5 p-8 text-center sm:p-12">
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
                            href="/#integracoes"
                            className="rounded-xl border border-rule px-5 py-3 font-mono text-[12px] uppercase tracking-[0.14em] text-fg transition-colors hover:border-accent/40"
                        >
                            {t("cta.integrations")}
                        </Link>
                    </div>
                </section>

                <footer className="mt-20 flex flex-wrap items-center justify-center gap-3 border-t border-hairline pt-8 text-xs text-fg-40">
                    <SiteLinks className="transition-colors hover:text-fg-60" />
                    <LegalLinks className="transition-colors hover:text-fg-60" />
                </footer>
            </div>
        </div>
    );
}
