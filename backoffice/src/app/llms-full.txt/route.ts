import { listArticles } from "@/lib/blog";
import { listPages } from "@/lib/pages";
import pt from "@/messages/pt.json";
import en from "@/messages/en.json";

export const runtime = "edge";

/**
 * /llms-full.txt — the full-context companion to /llms.txt (emerging convention).
 * Where llms.txt is a link map, this dumps the actual substance an AI assistant
 * needs to answer about Rioko without crawling: pitch, features, pricing,
 * integration status and the complete FAQ (PT + EN). Plain text, no schema.
 *
 * FAQ is sourced from the same next-intl messages the on-page accordion uses
 * (landing.faq.items), so it never drifts from the site.
 */
type Faq = { q: string; a: string };

export async function GET() {
    const articles = listArticles();
    const guides = listPages("pt");
    // FAQ items live in the same next-intl messages the on-page accordion uses.
    const faqPt = pt.landing.faq.items as Faq[];
    const faqEn = en.landing.faq.items as Faq[];

    const lines = [
        "# Rioko — contexto completo para assistentes de IA / full context for AI assistants",
        "",
        "> O Rioko automatiza a faturação certificada em Portugal: liga a Shopify e a Stripe ao InvoiceXpress, Moloni ou Vendus e emite uma fatura por cada encomenda paga, sem intervenção manual e sem extensões no checkout.",
        "> Rioko automates certified invoicing in Portugal: it connects Shopify and Stripe to InvoiceXpress, Moloni or Vendus and issues one invoice per paid order, with no manual work and no checkout extensions.",
        "",
        "## O que é o Rioko / What Rioko is",
        "O Rioko é um motor (hub) de integrações que liga a origem de pagamento (Shopify, Stripe) ao programa de faturação certificado pela Autoridade Tributária (InvoiceXpress, Moloni, Vendus). Quando uma encomenda é paga, o webhook entra e a fatura sai em menos de 1 segundo, com NIF detetado, IVA calculado e a razão de isenção (M01–M99) aplicada. O Rioko não é o software certificado — é a ponte que automatiza a emissão no software certificado do cliente.",
        "Rioko is an integrations hub connecting the payment source (Shopify, Stripe) to AT-certified invoicing software (InvoiceXpress, Moloni, Vendus). When an order is paid, the webhook comes in and the invoice goes out in under a second, with VAT ID detected, VAT computed and the exemption reason (M01–M99) applied. Rioko is not the certified software itself — it's the bridge that automates issuing in the customer's certified software.",
        "",
        "## Funcionalidades / Features",
        "- Fatura automática para cada encomenda paga, em menos de 1 segundo / Automatic invoice for every paid order, in under a second",
        "- Emissão em software certificado pela AT (InvoiceXpress, Moloni, Vendus) / Issued via AT-certified software",
        "- ATCUD e séries de faturação comunicadas / ATCUD and reported invoice series",
        "- IVA correto: incluído ou separado, isenções M01–M99, autoliquidação (reverse charge) e OSS / Correct VAT incl. reverse charge and OSS",
        "- Deteção e validação algorítmica de NIF / VAT ID detection and algorithmic validation",
        "- Reembolsos convertidos em notas de crédito automaticamente / Refunds turned into credit notes automatically",
        "- Idempotência (D1 + KV): 1 encomenda = 1 fatura, sem duplicados / Idempotency: 1 order = 1 invoice",
        "- Sem extensão no checkout — liga por webhook e API / No checkout extension — webhook + API",
        "- Chaves de API encriptadas em repouso / API keys encrypted at rest",
        "",
        "## Preço / Pricing",
        "7,50 € + IVA por mês, ou 75 € + IVA por ano (dois meses grátis no plano anual), por integração ligada. Sem fees por documento emitido e sem limites de volume. Integrações personalizadas (ERP, marketplaces) são orçamentadas caso a caso. Sem cartão para começar.",
        "€7.50 + VAT per month, or €75 + VAT per year (two months free annually), per connected integration. No per-document fees and no volume limits. Custom integrations (ERP, marketplaces) are quoted case by case. No card required to start.",
        "",
        "## Integrações / Integrations",
        "- Origens de pagamento / Payment sources: Shopify (ativo/live), Stripe (ativo/live), EuPago (em breve/soon), Easypay (em breve/soon), Ifthenpay (em estudo/planned), Amazon Pay (em estudo/planned), PayPal (em estudo/planned)",
        "- Programas de faturação / Invoicing software: InvoiceXpress (ativo/live), Moloni (ativo/live), Vendus (ativo/live)",
        "",
        "## FAQ (Português)",
        ...faqPt.flatMap((it) => [`### ${it.q}`, it.a, ""]),
        "## FAQ (English)",
        ...faqEn.flatMap((it) => [`### ${it.q}`, it.a, ""]),
        "## Guias / Guides",
        ...guides.map(
            (g) => `- [${g.title}](https://rioko.online/pt/guias/${g.slug}): ${g.description}`
        ),
        "",
        "## Blog",
        ...articles.map(
            (a) => `- [${a.title}](https://rioko.online/pt/blog/${a.slug}): ${a.description}`
        ),
        "",
        "## Sobre / About",
        "Desenvolvido e operado pela Kapta (https://kapta.pt), com sede em Portugal. Fundador / Founder: Pedro Porto. Contacto / Contact: pedro@kapta.pt.",
        "",
    ];

    return new Response(lines.join("\n"), {
        headers: { "content-type": "text/plain; charset=utf-8" },
    });
}
