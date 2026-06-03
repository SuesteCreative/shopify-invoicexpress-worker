/**
 * schema.org JSON-LD builders (GEO / structured data).
 *
 * Pure functions returning plain objects — render them server-side through
 * `@/components/JsonLd` so the markup lands in the SSR HTML (crawlers and AI
 * answer engines read it without executing JS).
 *
 * Stable `@id` anchors (`#organization`, `#website`, `#software`) let the
 * graph cross-reference itself (publisher → organization, etc.).
 */

import type { Article } from "./blog";

const SITE = "https://rioko.online";
const LOGO = `${SITE}/images/rioko2-logo.svg`;

type Locale = "pt" | "en" | string;

const DESC: Record<"pt" | "en", string> = {
    pt: "O Rioko automatiza a faturação certificada em Portugal: liga Shopify e Stripe ao InvoiceXpress, Moloni ou Vendus e emite faturas com ATCUD, séries, NIF e IVA sem intervenção manual.",
    en: "Rioko automates certified invoicing in Portugal: it connects Shopify and Stripe to InvoiceXpress, Moloni or Vendus and issues invoices with ATCUD, series, NIF and VAT with no manual work.",
};

const SLOGAN: Record<"pt" | "en", string> = {
    pt: "Uma fatura para cada encomenda, de cada plataforma.",
    en: "One invoice for every order, from every platform.",
};

const FEATURES: Record<"pt" | "en", string[]> = {
    pt: [
        "Fatura automática para cada encomenda paga, em menos de 1 segundo",
        "Emissão em software certificado pela AT (InvoiceXpress, Moloni, Vendus)",
        "ATCUD e séries de faturação comunicadas",
        "Cálculo de IVA correto: incluído ou separado, isenções M01–M99, autoliquidação e OSS",
        "Deteção e validação algorítmica de NIF",
        "Reembolsos convertidos em notas de crédito automaticamente",
        "Idempotência: 1 encomenda = 1 fatura, sem duplicados",
        "Sem extensão no checkout — liga por webhook e API",
        "Origens Shopify e Stripe; mais gateways no roadmap",
    ],
    en: [
        "Automatic invoice for every paid order, in under a second",
        "Issued via AT-certified software (InvoiceXpress, Moloni, Vendus)",
        "ATCUD and reported invoice series",
        "Correct VAT: included or separate, M01–M99 exemptions, reverse charge and OSS",
        "VAT ID detection and algorithmic validation",
        "Refunds turned into credit notes automatically",
        "Idempotency: 1 order = 1 invoice, no duplicates",
        "No checkout extension — connects via webhook and API",
        "Shopify and Stripe sources; more gateways on the roadmap",
    ],
};

function pickDesc(locale: Locale): string {
    return locale === "en" ? DESC.en : DESC.pt;
}

function isEn(locale: Locale): boolean {
    return locale === "en";
}

export function organizationSchema(locale: Locale = "pt") {
    return {
        "@context": "https://schema.org",
        "@type": "Organization",
        "@id": `${SITE}/#organization`,
        name: "Rioko",
        url: SITE,
        logo: { "@type": "ImageObject", url: LOGO },
        description: pickDesc(locale),
        slogan: isEn(locale) ? SLOGAN.en : SLOGAN.pt,
        areaServed: { "@type": "Country", name: "Portugal" },
        knowsLanguage: ["pt-PT", "en"],
        brand: { "@type": "Brand", name: "Rioko" },
        founder: { "@type": "Person", name: "Pedro Porto" },
        email: "pedro@kapta.pt",
        address: { "@type": "PostalAddress", addressCountry: "PT" },
        contactPoint: {
            "@type": "ContactPoint",
            email: "pedro@kapta.pt",
            contactType: "customer support",
            areaServed: "PT",
            availableLanguage: ["pt-PT", "en"],
        },
        parentOrganization: {
            "@type": "Organization",
            name: "Kapta",
            url: "https://kapta.pt",
        },
        // NOTE: `sameAs` (social profiles) intentionally omitted until real
        // Rioko/Kapta profiles exist — never link a dead profile. See GEO plan P0.7.
    };
}

export function websiteSchema(locale: Locale = "pt") {
    return {
        "@context": "https://schema.org",
        "@type": "WebSite",
        "@id": `${SITE}/#website`,
        name: "Rioko",
        url: SITE,
        inLanguage: ["pt-PT", "en"],
        publisher: { "@id": `${SITE}/#organization` },
    };
}

/**
 * SoftwareApplication + Offers. Prices are NET (ex-VAT) — every Offer carries a
 * UnitPriceSpecification with `valueAddedTaxIncluded: false`, billed per
 * integration. Custom tier is intentionally price-less ("sob consulta").
 */
export function softwareApplicationSchema(locale: Locale = "pt") {
    const perIntegration =
        locale === "en" ? "Price per integration, excl. VAT" : "Preço por integração, sem IVA";

    const offer = (price: string, billing: "MONTH" | "ANNUAL") => ({
        "@type": "Offer",
        priceCurrency: "EUR",
        price,
        description: perIntegration,
        priceSpecification: {
            "@type": "UnitPriceSpecification",
            price,
            priceCurrency: "EUR",
            valueAddedTaxIncluded: false,
            billingDuration: 1,
            billingIncrement: 1,
            unitText: billing,
            referenceQuantity: {
                "@type": "QuantitativeValue",
                value: 1,
                unitText: "integration",
            },
        },
    });

    return {
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        "@id": `${SITE}/#software`,
        name: "Rioko",
        url: SITE,
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        description: pickDesc(locale),
        featureList: isEn(locale) ? FEATURES.en : FEATURES.pt,
        offers: [offer("7.50", "MONTH"), offer("75.00", "ANNUAL")],
        publisher: { "@id": `${SITE}/#organization` },
        // NOTE: `aggregateRating` / `review` intentionally omitted until real
        // customer reviews exist — fabricated ratings risk a manual action. GEO plan P0.4.
    };
}

export function faqSchema(items: Array<{ q: string; a: string }>) {
    return {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        // speakable lets voice assistants read the Q&A aloud (best-effort hint).
        speakable: {
            "@type": "SpeakableSpecification",
            cssSelector: ["[data-faq-question]", "[data-faq-answer]"],
        },
        mainEntity: items.map((it) => ({
            "@type": "Question",
            name: it.q,
            acceptedAnswer: { "@type": "Answer", text: it.a },
        })),
    };
}

/**
 * HowTo for the on-page "how it works" flow (3 steps / ~4 min setup). Maps the
 * localized step copy from `landing.how` to schema.org HowToStep — answers
 * "how do I set this up" directly and is rich-result eligible. Pass the steps
 * from the page (they live in next-intl messages, like faqSchema's items).
 */
export function howToSchema(
    steps: Array<{ name: string; text: string }>,
    opts: { locale: Locale }
) {
    const en = isEn(opts.locale);
    return {
        "@context": "https://schema.org",
        "@type": "HowTo",
        name: en
            ? "How to set up automatic invoicing with Rioko"
            : "Como configurar faturação automática com o Rioko",
        description: pickDesc(opts.locale),
        totalTime: "PT4M",
        inLanguage: en ? "en" : "pt-PT",
        step: steps.map((s, i) => ({
            "@type": "HowToStep",
            position: i + 1,
            name: s.name,
            text: s.text,
            url: `${SITE}/${en ? "en" : "pt"}#how`,
        })),
    };
}

export function breadcrumbSchema(items: Array<{ name: string; url: string }>) {
    return {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: items.map((it, i) => ({
            "@type": "ListItem",
            position: i + 1,
            name: it.name,
            item: it.url,
        })),
    };
}

export function blogPostingSchema(
    article: Article,
    opts: { url: string; locale: Locale }
) {
    return {
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        headline: article.title,
        description: article.description,
        datePublished: article.date,
        dateModified: article.dateModified ?? article.date,
        inLanguage: opts.locale === "en" ? "en" : "pt-PT",
        mainEntityOfPage: { "@type": "WebPage", "@id": opts.url },
        url: opts.url,
        isAccessibleForFree: true,
        // Named author → Person (E-E-A-T); fall back to the Rioko org otherwise.
        author: article.author
            ? { "@type": "Person", name: article.author }
            : { "@type": "Organization", name: "Rioko", url: SITE },
        publisher: {
            "@type": "Organization",
            name: "Rioko",
            url: SITE,
            logo: { "@type": "ImageObject", url: LOGO },
        },
        ...(article.category ? { articleSection: article.category } : {}),
        ...(article.heroImage ? { image: article.heroImage } : {}),
        ...(article.tags ? { keywords: article.tags.join(", ") } : {}),
    };
}

/**
 * Article for use-case / comparison "guias" pages (lib/pages.ts). Like
 * blogPostingSchema but a plain Article, and author/publisher reference the
 * global #organization node (injected on every page via the layout).
 */
export function articleSchema(
    page: {
        title: string;
        description: string;
        date: string;
        dateModified?: string;
        heroImage?: string;
        tags?: string[];
    },
    opts: { url: string; locale: Locale; about?: string }
) {
    return {
        "@context": "https://schema.org",
        "@type": "Article",
        headline: page.title,
        description: page.description,
        datePublished: page.date,
        dateModified: page.dateModified ?? page.date,
        inLanguage: isEn(opts.locale) ? "en" : "pt-PT",
        mainEntityOfPage: { "@type": "WebPage", "@id": opts.url },
        url: opts.url,
        isAccessibleForFree: true,
        author: { "@id": `${SITE}/#organization` },
        publisher: { "@id": `${SITE}/#organization` },
        ...(opts.about ? { about: opts.about } : {}),
        ...(page.heroImage ? { image: page.heroImage } : {}),
        ...(page.tags ? { keywords: page.tags.join(", ") } : {}),
    };
}
