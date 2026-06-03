import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Image from "next/image";
import { Link } from "@/i18n/navigation";
import { getArticleBySlug, listSlugs, listArticles } from "@/lib/blog";
import JsonLd from "@/components/JsonLd";
import { blogPostingSchema, breadcrumbSchema } from "@/lib/schema";
import { ArrowLeft, Calendar, Clock, ExternalLink, ArrowRight } from "lucide-react";

type Props = {
    params: Promise<{ slug: string; locale: string }>;
};

export async function generateStaticParams() {
    return listSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { slug, locale } = await params;
    const article = getArticleBySlug(slug);
    if (!article) return { title: "Artigo não encontrado" };

    return {
        title: `${article.title} — Blog Rioko`,
        description: article.description,
        alternates: {
            canonical: `/${locale}/blog/${slug}`,
            languages: {
                pt: `/pt/blog/${slug}`,
                en: `/en/blog/${slug}`,
                "x-default": `/pt/blog/${slug}`,
            },
        },
        openGraph: {
            title: article.title,
            description: article.description,
            type: "article",
            publishedTime: article.date,
            authors: article.author ? [article.author] : undefined,
            tags: article.tags,
            images: article.heroImage ? [article.heroImage] : undefined,
        },
    };
}

export default async function BlogArticlePage({ params }: Props) {
    const { slug, locale } = await params;
    const article = getArticleBySlug(slug);
    if (!article) notFound();

    const { Content } = article;
    const related = listArticles().filter((a) => a.slug !== slug).slice(0, 3);

    // JSON-LD: BlogPosting + breadcrumb trail (Início/Home → Blog → article)
    const url = `https://rioko.online/${locale}/blog/${slug}`;
    const articleSchema = blogPostingSchema(article, { url, locale });
    const breadcrumb = breadcrumbSchema([
        { name: locale === "en" ? "Home" : "Início", url: `https://rioko.online/${locale}` },
        { name: "Blog", url: `https://rioko.online/${locale}/blog` },
        { name: article.title, url },
    ]);

    return (
        <div className="min-h-screen bg-surface text-fg">
            <JsonLd data={articleSchema} />
            <JsonLd data={breadcrumb} />

            <article className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-16">
                <Link href={"/blog" as any} className="inline-flex items-center gap-2 text-sm text-fg-60 hover:text-fg transition-colors mb-8">
                    <ArrowLeft className="w-4 h-4" /> Todos os artigos
                </Link>

                <header className="mb-10">
                    <div className="flex flex-wrap items-center gap-3 mb-4">
                        {article.category && (
                            <span className="font-mono text-[10px] text-accent uppercase tracking-[0.22em] px-2 py-1 rounded-md border border-[rgba(2,141,196,0.30)] bg-[rgba(2,141,196,0.05)]">
                                {article.category}
                            </span>
                        )}
                        <span className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.18em] flex items-center gap-1.5">
                            <Calendar className="w-3 h-3" />
                            {formatDate(article.date)}
                        </span>
                        {article.readingMinutes && (
                            <span className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.18em] flex items-center gap-1.5">
                                <Clock className="w-3 h-3" />
                                {article.readingMinutes} min
                            </span>
                        )}
                    </div>

                    <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight text-fg mb-4">
                        {article.title}
                    </h1>

                    <p className="text-lg text-fg-60 leading-relaxed">
                        {article.description}
                    </p>
                </header>

                {article.heroImage && (
                    <div className="mb-10 -mx-4 sm:mx-0">
                        <Image
                            src={article.heroImage}
                            alt={article.title}
                            width={1200}
                            height={675}
                            className="w-full h-auto sm:rounded-2xl border border-hairline"
                            priority
                        />
                    </div>
                )}

                <div className="prose-rioko">
                    <Content />
                </div>

                {article.source && (
                    <div className="mt-12 pt-6 border-t border-hairline">
                        <p className="text-xs text-fg-40 flex items-start gap-2">
                            <ExternalLink className="w-3 h-3 mt-0.5 shrink-0" />
                            <span>
                                Fonte original:{" "}
                                <a href={article.source} target="_blank" rel="noopener noreferrer" className="text-fg-60 hover:text-accent underline decoration-1 underline-offset-2">
                                    {new URL(article.source).hostname}
                                </a>
                            </span>
                        </p>
                    </div>
                )}

                {article.tags && article.tags.length > 0 && (
                    <div className="mt-8 flex flex-wrap gap-2">
                        {article.tags.map((tag) => (
                            <span key={tag} className="text-[10px] font-mono text-fg-60 uppercase tracking-[0.14em] px-3 py-1 rounded-full bg-surface-2 border border-hairline">
                                #{tag}
                            </span>
                        ))}
                    </div>
                )}
            </article>

            {related.length > 0 && (
                <section className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-12 py-12 border-t border-hairline">
                    <h2 className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em] mb-6">Artigos relacionados</h2>
                    <div className="grid sm:grid-cols-3 gap-4">
                        {related.map((r) => (
                            <Link
                                key={r.slug}
                                href={`/blog/${r.slug}` as any}
                                className="group glass rounded-2xl p-5 border border-hairline hover:border-rule transition-all"
                            >
                                <h3 className="text-sm font-semibold text-fg group-hover:text-accent-hot transition-colors mb-2 line-clamp-3">
                                    {r.title}
                                </h3>
                                <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-fg-40 flex items-center gap-1">
                                    Ler <ArrowRight className="w-3 h-3" />
                                </span>
                            </Link>
                        ))}
                    </div>
                </section>
            )}
        </div>
    );
}

function formatDate(isoDate: string): string {
    try {
        const d = new Date(isoDate);
        return d.toLocaleDateString("pt-PT", { day: "2-digit", month: "long", year: "numeric" });
    } catch {
        return isoDate;
    }
}
