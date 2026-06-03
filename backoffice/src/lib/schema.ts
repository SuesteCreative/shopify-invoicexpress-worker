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

function pickDesc(locale: Locale): string {
    return locale === "en" ? DESC.en : DESC.pt;
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
        areaServed: { "@type": "Country", name: "Portugal" },
        knowsLanguage: ["pt-PT", "en"],
        brand: { "@type": "Brand", name: "Rioko" },
        parentOrganization: {
            "@type": "Organization",
            name: "Kapta",
            url: "https://kapta.pt",
        },
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
        offers: [offer("7.50", "MONTH"), offer("75.00", "ANNUAL")],
        publisher: { "@id": `${SITE}/#organization` },
    };
}

export function faqSchema(items: Array<{ q: string; a: string }>) {
    return {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: items.map((it) => ({
            "@type": "Question",
            name: it.q,
            acceptedAnswer: { "@type": "Answer", text: it.a },
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
        author: {
            "@type": "Organization",
            name: article.author ?? "Rioko",
            url: SITE,
        },
        publisher: {
            "@type": "Organization",
            name: "Rioko",
            url: SITE,
            logo: { "@type": "ImageObject", url: LOGO },
        },
        ...(article.heroImage ? { image: article.heroImage } : {}),
        ...(article.tags ? { keywords: article.tags.join(", ") } : {}),
    };
}
