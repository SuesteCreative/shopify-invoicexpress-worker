import { listArticles } from "@/lib/blog";
import { listPages } from "@/lib/pages";

export const runtime = "edge";

/**
 * /llms.txt — a plain-text map of the site for AI agents (llms.txt convention).
 * One-line pitch, key URLs, and the live blog index. Plain code, no schema.
 */
export async function GET() {
    const articles = listArticles();
    const guides = listPages("pt");

    const lines = [
        "# Rioko",
        "",
        "> O Rioko automatiza a faturação certificada em Portugal: liga a Shopify e a Stripe ao InvoiceXpress, Moloni ou Vendus e emite faturas com ATCUD, séries, NIF e IVA automaticamente, sem extensões no checkout. / Rioko automates certified invoicing in Portugal: it connects Shopify and Stripe to InvoiceXpress, Moloni or Vendus and issues invoices automatically, with no checkout extensions.",
        "",
        "## Factos / Key facts",
        "- Operado pela Kapta (https://kapta.pt), com sede em Portugal. Contacto: pedro@kapta.pt",
        "- O Rioko não emite faturas — envia os dados ao software certificado pela AT (InvoiceXpress, Moloni, Vendus), que emite o documento.",
        "- Preço: 7,50 € + IVA/mês ou 75 € + IVA/ano, por integração. Sem fees por documento, sem limites de volume.",
        "- Origens de pagamento ATIVAS: Shopify, Stripe. Em breve: EuPago, Easypay. Em estudo: Ifthenpay, Amazon Pay, PayPal.",
        "- Programas de faturação ATIVOS: InvoiceXpress, Moloni, Vendus.",
        "- Configuração: ~4 minutos, sem cartão para começar, sem extensão no checkout (webhook + API).",
        "",
        "## Site (PT)",
        "- [Início](https://rioko.online/pt): visão geral, integrações, preço e FAQ",
        "- [Preço](https://rioko.online/pt#preco): 7,50 € + IVA/mês ou 75 € + IVA/ano, por integração",
        "- [FAQ](https://rioko.online/pt#faq): perguntas frequentes sobre faturação automática",
        "- [Blog](https://rioko.online/pt/blog): guias fiscais e técnicos",
        "- [Privacidade](https://rioko.online/pt/privacy) · [Termos](https://rioko.online/pt/terms)",
        "",
        "## Site (EN)",
        "- [Home](https://rioko.online/en): overview, integrations, pricing and FAQ",
        "- [Pricing](https://rioko.online/en#preco): €7.50 + VAT/month or €75 + VAT/year, per integration",
        "- [FAQ](https://rioko.online/en#faq): frequently asked questions about automatic invoicing",
        "- [Blog](https://rioko.online/en/blog): fiscal and technical guides",
        "",
        "## Guias",
        ...guides.map(
            (g) => `- [${g.title}](https://rioko.online/pt/guias/${g.slug}): ${g.description}`
        ),
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
        "Desenvolvido pela Kapta (https://kapta.pt). Fundador: Pedro Porto. Origens de pagamento: Shopify, Stripe. Programas de faturação: InvoiceXpress, Moloni, Vendus.",
        "",
    ];

    return new Response(lines.join("\n"), {
        headers: { "content-type": "text/plain; charset=utf-8" },
    });
}
