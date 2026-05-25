import type { Metadata } from "next";
import { Link } from "@/i18n/navigation";
import { listArticles } from "@/lib/blog";
import { Calendar, ArrowRight } from "lucide-react";

export const runtime = "edge";

export const metadata: Metadata = {
    title: "Blog Rioko — Guias Fiscais e Técnicos",
    description: "Artigos sobre faturação automática em Portugal: ATCUD, séries certificadas, IVA OSS, reverse charge, integrações Shopify/Stripe com InvoiceXpress/Moloni/Vendus.",
    openGraph: {
        title: "Blog Rioko — Guias Fiscais e Técnicos",
        description: "Artigos sobre faturação automática em Portugal.",
        type: "website",
    },
};

export default function BlogIndexPage() {
    const articles = listArticles();

    return (
        <div className="min-h-screen bg-surface text-fg">
            <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-12 py-12 sm:py-20">
                <header className="mb-16 text-center">
                    <p className="font-mono text-[11px] text-fg-40 uppercase tracking-[0.22em] mb-4">Blog Rioko</p>
                    <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight bg-gradient-to-r from-fg via-fg to-fg-40 bg-clip-text text-transparent">
                        Guias Fiscais e Técnicos
                    </h1>
                    <p className="mt-4 text-fg-60 max-w-2xl mx-auto leading-relaxed">
                        Como cumprir as obrigações fiscais portuguesas com automação total entre Shopify/Stripe e InvoiceXpress/Moloni/Vendus.
                    </p>
                </header>

                <div className="grid gap-6">
                    {articles.map((article) => (
                        <Link
                            key={article.slug}
                            href={`/blog/${article.slug}` as any}
                            className="group glass rounded-[2rem] p-6 sm:p-8 border border-hairline hover:border-rule transition-all"
                        >
                            <div className="flex items-start justify-between gap-4 mb-3">
                                {article.category && (
                                    <span className="font-mono text-[10px] text-accent uppercase tracking-[0.22em] px-2 py-1 rounded-md border border-[rgba(2,141,196,0.30)] bg-[rgba(2,141,196,0.05)]">
                                        {article.category}
                                    </span>
                                )}
                                <span className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.18em] flex items-center gap-1.5">
                                    <Calendar className="w-3 h-3" />
                                    {formatDate(article.date)}
                                </span>
                            </div>

                            <h2 className="text-xl sm:text-2xl font-semibold tracking-tight text-fg group-hover:text-accent-hot transition-colors mb-3">
                                {article.title}
                            </h2>

                            <p className="text-sm text-fg-60 leading-relaxed mb-4">
                                {article.description}
                            </p>

                            <div className="flex items-center justify-between">
                                {article.tags && article.tags.length > 0 && (
                                    <div className="flex flex-wrap gap-2">
                                        {article.tags.slice(0, 3).map((tag) => (
                                            <span key={tag} className="text-[10px] font-mono text-fg-40 uppercase tracking-[0.14em] px-2 py-0.5 rounded bg-surface-2 border border-hairline">
                                                {tag}
                                            </span>
                                        ))}
                                    </div>
                                )}
                                <span className="text-xs font-mono uppercase tracking-[0.18em] text-fg-60 group-hover:text-accent-hot transition-colors flex items-center gap-1 shrink-0">
                                    Ler <ArrowRight className="w-3 h-3" />
                                </span>
                            </div>
                        </Link>
                    ))}
                </div>

                {articles.length === 0 && (
                    <div className="text-center py-20">
                        <p className="text-fg-40 font-mono text-sm uppercase tracking-[0.22em]">Sem artigos publicados ainda.</p>
                    </div>
                )}
            </div>
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
