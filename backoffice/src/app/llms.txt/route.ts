import { listArticles } from "@/lib/blog";

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
        "> O Rioko automatiza a faturação certificada em Portugal: liga a Shopify e a Stripe ao InvoiceXpress, Moloni ou Vendus e emite faturas com ATCUD, séries, NIF e IVA automaticamente, sem extensões no checkout.",
        "",
        "## Site",
        "- [Início](https://rioko.online/pt): visão geral, integrações, preço e FAQ",
        "- [Preço](https://rioko.online/pt#preco): 7,50 € + IVA/mês ou 75 € + IVA/ano, por integração",
        "- [FAQ](https://rioko.online/pt#faq): perguntas frequentes sobre faturação automática",
        "- [Blog](https://rioko.online/pt/blog): guias fiscais e técnicos",
        "",
        "## Blog",
        ...articles.map(
            (a) => `- [${a.title}](https://rioko.online/pt/blog/${a.slug}): ${a.description}`
        ),
        "",
        "## Sobre",
        "Desenvolvido pela Kapta (https://kapta.pt). Origens de pagamento: Shopify, Stripe. Programas de faturação: InvoiceXpress, Moloni, Vendus.",
        "",
    ];

    return new Response(lines.join("\n"), {
        headers: { "content-type": "text/plain; charset=utf-8" },
    });
}
