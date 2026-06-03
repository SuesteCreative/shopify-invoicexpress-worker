import type { Metadata } from "next";
import { Link } from "@/i18n/navigation";
import { listPages } from "@/lib/pages";
import JsonLd from "@/components/JsonLd";
import { breadcrumbSchema } from "@/lib/schema";
import { ArrowRight } from "lucide-react";

export const runtime = "edge";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { locale } = await params;
    const isEn = locale === "en";
    return {
        title: isEn ? "Guides — Rioko" : "Guias — Rioko",
        description: isEn
            ? "Practical guides on automatic certified invoicing in Portugal: Shopify, Stripe, InvoiceXpress, Moloni, Vendus, VAT, OSS and reverse charge."
            : "Guias práticos sobre faturação automática certificada em Portugal: Shopify, Stripe, InvoiceXpress, Moloni, Vendus, IVA, OSS e autoliquidação.",
        alternates: {
            canonical: `/${locale}/guias`,
            languages: { pt: "/pt/guias", "x-default": "/pt/guias" },
        },
        openGraph: { title: isEn ? "Rioko Guides" : "Guias Rioko", type: "website" },
    };
}

export default async function GuidesIndexPage({ params }: Props) {
    const { locale } = await params;
    const isEn = locale === "en";
    const pages = listPages(locale);
    const breadcrumb = breadcrumbSchema([
        { name: isEn ? "Home" : "Início", url: `https://rioko.online/${locale}` },
        { name: isEn ? "Guides" : "Guias", url: `https://rioko.online/${locale}/guias` },
    ]);

    return (
        <div className="min-h-screen bg-surface text-fg">
            <JsonLd data={breadcrumb} />
            <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-12 py-12 sm:py-20">
                <header className="mb-16 text-center">
                    <p className="font-mono text-[11px] text-fg-40 uppercase tracking-[0.22em] mb-4">
                        {isEn ? "Rioko Guides" : "Guias Rioko"}
                    </p>
                    <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight bg-gradient-to-r from-fg via-fg to-fg-40 bg-clip-text text-transparent">
                        {isEn ? "Automatic invoicing, explained" : "Faturação automática, explicada"}
                    </h1>
                    <p className="mt-4 text-fg-60 max-w-2xl mx-auto leading-relaxed">
                        {isEn
                            ? "How to connect Shopify and Stripe to InvoiceXpress, Moloni or Vendus and invoice every order automatically — VAT, ATCUD and series included."
                            : "Como ligar a Shopify e a Stripe ao InvoiceXpress, Moloni ou Vendus e faturar cada encomenda automaticamente — com IVA, ATCUD e séries."}
                    </p>
                </header>

                <div className="grid gap-6">
                    {pages.map((p) => (
                        <Link
                            key={p.slug}
                            href={`/guias/${p.slug}`}
                            className="group glass rounded-[2rem] p-6 sm:p-8 border border-hairline hover:border-rule transition-all"
                        >
                            <div className="flex items-start justify-between gap-4 mb-3">
                                <span className="font-mono text-[10px] text-accent uppercase tracking-[0.22em] px-2 py-1 rounded-md border border-[rgba(2,141,196,0.30)] bg-[rgba(2,141,196,0.05)]">
                                    {p.kind === "comparison"
                                        ? isEn ? "Comparison" : "Comparação"
                                        : isEn ? "Guide" : "Guia"}
                                </span>
                            </div>
                            <h2 className="text-xl sm:text-2xl font-semibold tracking-tight text-fg group-hover:text-accent-hot transition-colors mb-3">
                                {p.title}
                            </h2>
                            <p className="text-sm text-fg-60 leading-relaxed mb-4">{p.description}</p>
                            <span className="text-xs font-mono uppercase tracking-[0.18em] text-fg-60 group-hover:text-accent-hot transition-colors flex items-center gap-1 shrink-0">
                                {isEn ? "Read" : "Ler"} <ArrowRight className="w-3 h-3" />
                            </span>
                        </Link>
                    ))}
                </div>

                {pages.length === 0 && (
                    <div className="text-center py-20">
                        <p className="text-fg-40 font-mono text-sm uppercase tracking-[0.22em]">
                            {isEn ? "No guides yet." : "Sem guias ainda."}
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}
