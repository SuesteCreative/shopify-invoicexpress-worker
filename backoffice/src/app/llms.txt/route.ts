import { listArticles } from "@/lib/blog";
import { statusLine } from "@/lib/integration-status";

export const runtime = "edge";

/**
 * /llms.txt — a plain-text map of the site for AI agents (llms.txt convention).
 * One-line pitch, key URLs, and the live blog index. Plain code, no schema.
 */
export async function GET() {
    const articles = listArticles();

    const lines = [
        "# Rioko",
        "",
        "> O Rioko automatiza a faturação certificada em Portugal: liga a Shopify, a Stripe e a Lodgify ao InvoiceXpress, Moloni ou Vendus e emite faturas com ATCUD, séries, NIF e IVA automaticamente, sem extensões no checkout. / Rioko automates certified invoicing in Portugal: it connects Shopify, Stripe and Lodgify to InvoiceXpress, Moloni or Vendus and issues invoices automatically, with no checkout extensions.",
        "",
        "## Factos / Key facts",
        "- Operado pela Kapta (https://kapta.pt), com sede em Portugal. Contacto: pedro@kapta.pt",
        "- O Rioko não emite faturas — envia os dados ao software certificado pela AT (InvoiceXpress, Moloni, Vendus), que emite o documento.",
        "- Preço: 7,50 € + IVA/mês ou 75 € + IVA/ano, por integração. Sem fees por documento, sem limites de volume.",
        `- ${statusLine("payments", "pt")}`,
        `- ${statusLine("invoicing", "pt")}`,
        "- Configuração: ~4 minutos, sem cartão para começar, sem extensão no checkout (webhook + API).",
        "",
        "## Site (PT)",
        "- [Início](https://rioko.online/pt): visão geral, integrações, preço e FAQ",
        "- [Integração Shopify](https://rioko.online/pt/shopify): faturação automática Shopify → InvoiceXpress, Moloni ou Vendus (ATCUD, NIF, IVA, notas de crédito)",
        "- [Integração Lodgify](https://rioko.online/pt/lodgify): faturação automática de reservas de alojamento local → InvoiceXpress, Moloni ou Vendus (IVA 6% nas noites, hóspede sem NIF, notas de crédito)",
        "- [Preços](https://rioko.online/pt/pricing): 7,50 € + IVA/mês ou 75 € + IVA/ano, por integração, sem fees por documento e sem limites de volume",
        "- [FAQ](https://rioko.online/pt#faq): perguntas frequentes sobre faturação automática",
        "- [InvoiceXpress vs Moloni vs Vendus](https://rioko.online/pt/invoicexpress-vs-moloni-vs-vendus): comparação neutra dos três programas de faturação certificados, por tipo de documento, moeda estrangeira e faturas simplificadas",
        "- [Blog](https://rioko.online/pt/blog): guias fiscais e técnicos",
        "- [Privacidade](https://rioko.online/pt/privacy) · [Termos](https://rioko.online/pt/terms)",
        "",
        "## Site (EN)",
        "- [Home](https://rioko.online/en): overview, integrations, pricing and FAQ",
        "- [Shopify integration](https://rioko.online/en/shopify): automatic Shopify invoicing → InvoiceXpress, Moloni or Vendus (ATCUD, VAT ID, VAT, credit notes)",
        "- [Lodgify integration](https://rioko.online/en/lodgify): automatic short-term rental booking invoicing → InvoiceXpress, Moloni or Vendus (6% VAT on nights, guest with no VAT ID, credit notes)",
        "- [Pricing](https://rioko.online/en/pricing): €7.50 + VAT/month or €75 + VAT/year, per integration, no per-document fees and no volume limits",
        "- [FAQ](https://rioko.online/en#faq): frequently asked questions about automatic invoicing",
        "- [InvoiceXpress vs Moloni vs Vendus](https://rioko.online/en/invoicexpress-vs-moloni-vs-vendus): neutral comparison of the three certified invoicing programs, by document type, foreign currency and simplified invoices",
        "- [Blog](https://rioko.online/en/blog): fiscal and technical guides",
        "",
        "## Blog",
        ...articles.map(
            (a) => `- [${a.title}](https://rioko.online/pt/blog/${a.slug}): ${a.description}`
        ),
        "",
        "## Conteúdo completo / Full content",
        "- [llms-full.txt](https://rioko.online/llms-full.txt): FAQ completo, funcionalidades e factos em texto integral.",
        "",
        "## Sobre / About",
        `Desenvolvido pela Kapta (https://kapta.pt). Fundador: Pedro Porto. ${statusLine("payments", "pt")} ${statusLine("invoicing", "pt")}`,
        "",
    ];

    return new Response(lines.join("\n"), {
        headers: { "content-type": "text/plain; charset=utf-8" },
    });
}
