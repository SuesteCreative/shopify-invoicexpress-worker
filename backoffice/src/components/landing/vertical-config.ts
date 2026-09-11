/**
 * The per-source configuration behind the vertical landings.
 *
 * `/shopify`, `/lodgify` and `/stripe` are the same "Midnight Ledger" page with
 * a different source platform bolted on. Everything that actually differs
 * between them is either copy (which lives in next-intl messages, one namespace
 * per variant) or one of the few hard facts below.
 *
 * Cloning the 1800-line component three times would have been the other option.
 * It would also have meant fixing every future bug three times.
 */

export type VerticalVariant = {
    /** URL segment, also the anchor base for the HowTo JSON-LD. */
    slug: string;
    /** next-intl namespace holding this page's copy. */
    ns: string;
    origin: { name: string; logo: string };
    /**
     * The line shown in the "connect" code block. Not decoration: it has to be
     * the real shape of what that platform sends us, because a merchant who
     * recognises it trusts the rest of the page.
     */
    connectLine: string;
    /** Fiscal-artifact marquee. The first items are source-specific. */
    tickerItems: string[];
};

/** Artifacts every Portuguese invoice carries, whatever produced the sale. */
const FISCAL_TICKER = [
    "ATCUD JFX8PR2J-847",
    "NIF 245 187 663 ✓",
    "IVA 23% · 13% · 6%",
    "M16 · ISENTO",
    "OSS · UE",
    "200 OK · 347 MS",
];

export const VERTICALS: Record<string, VerticalVariant> = {
    shopify: {
        slug: "shopify",
        ns: "shopifyLanding",
        origin: { name: "Shopify", logo: "/images/shopify-logo.webp" },
        connectLine: '{ "shopify_domain": "minha-loja.myshopify.com",',
        tickerItems: [
            "FT 2026A/847",
            ...FISCAL_TICKER,
            "orders/paid",
            "refunds/create → NC 2026A/12",
            "1 ENCOMENDA = 1 FATURA",
        ],
    },
    lodgify: {
        slug: "lodgify",
        ns: "lodgifyLanding",
        origin: { name: "Lodgify", logo: "/images/lodgify-logo-black.svg" },
        connectLine: '{ "property": "Casa da Praia", "booking": "B-48120",',
        tickerItems: [
            "FR 2026A/312",
            ...FISCAL_TICKER,
            "IVA 6% · ALOJAMENTO",
            "CHECK-OUT → FATURA",
            "1 RESERVA = 1 FATURA",
        ],
    },
    stripe: {
        slug: "stripe",
        ns: "stripeLanding",
        origin: { name: "Stripe", logo: "/images/stripe-logo.svg" },
        connectLine: '{ "id": "pi_3TrIAO2eZvKYlo2C", "currency": "eur",',
        tickerItems: [
            "FR 2026A/1204",
            ...FISCAL_TICKER,
            "payment_intent.succeeded",
            "charge.refunded → NC 2026A/33",
            "1 PAGAMENTO = 1 FATURA",
        ],
    },
};
