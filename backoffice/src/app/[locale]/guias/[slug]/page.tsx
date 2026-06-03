import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Link } from "@/i18n/navigation";
import { getPage, listPageSlugs, listPages, localesForSlug } from "@/lib/pages";
import JsonLd from "@/components/JsonLd";
import FaqAccordion from "@/components/FaqAccordion";
import GuideCta from "@/components/GuideCta";
import { articleSchema, faqSchema, breadcrumbSchema } from "@/lib/schema";
import { ArrowLeft, ArrowRight, Calendar } from "lucide-react";

export const runtime = "edge";

type Props = { params: Promise<{ slug: string; locale: string }> };

export function generateStaticParams() {
    return listPageSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { slug, locale } = await params;
    const page = getPage(slug, locale);
    if (!page) return { title: "Página não encontrada" };

    // hreflang: only the locales that actually have a translated file (+ x-default).
    const languages: Record<string, string> = Object.fromEntries(
        localesForSlug(slug).map((l) => [l, `/${l}/guias/${slug}`])
    );
    languages["x-default"] = `/pt/guias/${slug}`;

    return {
        title: `${page.title} — Rioko`,
        description: page.description,
        alternates: { canonical: `/${locale}/guias/${slug}`, languages },
        openGraph: {
            title: page.title,
            description: page.description,
            type: "article",
            publishedTime: page.date,
            modifiedTime: page.dateModified ?? page.date,
            tags: page.tags,
        },
    };
}

export default async function GuidePage({ params }: Props) {
    const { slug, locale } = await params;
    const page = getPage(slug, locale);
    // Honest locale guard: no translated file → 404 (never serve PT under /en).
    if (!page) notFound();

    const { Content } = page;
    const isEn = locale === "en";
    const url = `https://rioko.online/${locale}/guias/${slug}`;

    const article = articleSchema(page, {
        url,
        locale,
        about: isEn ? "Automatic invoicing in Portugal" : "Faturação automática em Portugal",
    });
    const breadcrumb = breadcrumbSchema([
        { name: isEn ? "Home" : "Início", url: `https://rioko.online/${locale}` },
        { name: isEn ? "Guides" : "Guias", url: `https://rioko.online/${locale}/guias` },
        { name: page.title, url },
    ]);
    const related = listPages(locale).filter((p) => p.slug !== slug).slice(0, 3);

    return (
        <div className="min-h-screen bg-surface text-fg">
            <JsonLd data={article} />
            {page.faq?.length ? <JsonLd data={faqSchema(page.faq)} /> : null}
            <JsonLd data={breadcrumb} />

            <article className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-16">
                <Link
                    href="/guias"
                    className="inline-flex items-center gap-2 text-sm text-fg-60 hover:text-fg transition-colors mb-8"
                >
                    <ArrowLeft className="w-4 h-4" /> {isEn ? "All guides" : "Todos os guias"}
                </Link>

                <header className="mb-10">
                    <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight text-fg mb-4">
                        {page.title}
                    </h1>
                    <p className="text-lg text-fg-60 leading-relaxed">{page.description}</p>
                    {page.updated && (
                        <p className="mt-4 font-mono text-[10px] text-fg-40 uppercase tracking-[0.18em] flex items-center gap-1.5">
                            <Calendar className="w-3 h-3" />
                            {isEn ? "Updated" : "Atualizado"}: {page.updated}
                        </p>
                    )}
                </header>

                <div className="prose-rioko">
                    <Content />
                </div>

                {page.faq?.length ? (
                    <section className="mt-14">
                        <h2 className="text-2xl font-semibold tracking-tight text-fg">
                            {isEn ? "Frequently asked questions" : "Perguntas frequentes"}
                        </h2>
                        <FaqAccordion items={page.faq} />
                    </section>
                ) : null}

                <GuideCta locale={locale} />
            </article>

            {related.length > 0 && (
                <section className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-12 py-12 border-t border-hairline">
                    <h2 className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em] mb-6">
                        {isEn ? "Related guides" : "Guias relacionados"}
                    </h2>
                    <div className="grid sm:grid-cols-3 gap-4">
                        {related.map((r) => (
                            <Link
                                key={r.slug}
                                href={`/guias/${r.slug}`}
                                className="group glass rounded-2xl p-5 border border-hairline hover:border-rule transition-all"
                            >
                                <h3 className="text-sm font-semibold text-fg group-hover:text-accent-hot transition-colors mb-2 line-clamp-3">
                                    {r.title}
                                </h3>
                                <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-fg-40 flex items-center gap-1">
                                    {isEn ? "Read" : "Ler"} <ArrowRight className="w-3 h-3" />
                                </span>
                            </Link>
                        ))}
                    </div>
                </section>
            )}
        </div>
    );
}
