/**
 * What Rioko publicly supports, and how far along each one is.
 *
 * Single source of truth for every *public* surface that states integration
 * status: the landing matrix, `/llms.txt` and `/llms-full.txt`. They used to
 * keep three private copies and drifted apart — the FAQ and both llms files
 * were still calling Moloni and Vendus "roadmap" months after they went live,
 * and never mentioned Lodgify at all. Since those files are exactly what an AI
 * assistant reads to answer "does Rioko support Moloni?", the stale copy was
 * actively telling people no.
 *
 * `connection-kinds.ts` is the *internal* registry (what the API accepts).
 * This is the *public* story, which also covers things we have not built yet.
 */

export type IntegrationStatus = "live" | "soon" | "planned";
export type IntegrationKind = "payments" | "invoicing";

export type PublicIntegration = {
    id: string;
    name: string;
    kind: IntegrationKind;
    status: IntegrationStatus;
    logoSrc?: string;
};

export const PUBLIC_INTEGRATIONS: PublicIntegration[] = [
    { id: "shopify", name: "Shopify", kind: "payments", status: "live", logoSrc: "/images/shopify-logo.webp" },
    { id: "stripe", name: "Stripe", kind: "payments", status: "live", logoSrc: "/images/stripe-logo.svg" },
    { id: "lodgify", name: "Lodgify", kind: "payments", status: "live", logoSrc: "/images/lodgify-logo-black.svg" },
    { id: "eupago", name: "EuPago", kind: "payments", status: "soon", logoSrc: "/images/eupago-logo.svg" },
    { id: "easypay", name: "Easypay", kind: "payments", status: "soon", logoSrc: "/images/easypay-logo.svg" },
    { id: "ifthenpay", name: "Ifthenpay", kind: "payments", status: "planned", logoSrc: "/images/ifthenpay-logo.svg" },
    { id: "amazon", name: "Amazon Pay", kind: "payments", status: "planned", logoSrc: "/images/amazon-logo.svg" },
    { id: "paypal", name: "PayPal", kind: "payments", status: "planned", logoSrc: "/images/paypal-logo.svg" },
    { id: "invoicexpress", name: "InvoiceXpress", kind: "invoicing", status: "live", logoSrc: "/images/invoicexpress-logo.svg" },
    { id: "moloni", name: "Moloni", kind: "invoicing", status: "live", logoSrc: "/images/moloni-logo.svg" },
    { id: "vendus", name: "Vendus", kind: "invoicing", status: "live", logoSrc: "/images/vendus-logo.svg" },
];

function names(kind: IntegrationKind, status: IntegrationStatus): string[] {
    return PUBLIC_INTEGRATIONS.filter((i) => i.kind === kind && i.status === status).map((i) => i.name);
}

/** "Shopify, Stripe e Lodgify" / "Shopify, Stripe and Lodgify" */
function list(items: string[], locale: "pt" | "en"): string {
    if (items.length === 0) return locale === "pt" ? "nenhum" : "none";
    if (items.length === 1) return items[0];
    const conjunction = locale === "pt" ? " e " : " and ";
    return items.slice(0, -1).join(", ") + conjunction + items[items.length - 1];
}

/**
 * One prose line per integration kind, for the plain-text AI grounding files.
 * Generated rather than written by hand — that is the whole point of this file.
 */
export function statusLine(kind: IntegrationKind, locale: "pt" | "en"): string {
    const live = list(names(kind, "live"), locale);
    const soon = names(kind, "soon");
    const planned = names(kind, "planned");

    const label =
        locale === "pt"
            ? kind === "payments"
                ? "Origens de pagamento"
                : "Programas de faturação"
            : kind === "payments"
              ? "Payment sources"
              : "Invoicing software";

    const parts = [
        locale === "pt" ? `${label} disponíveis: ${live}` : `${label} available today: ${live}`,
    ];
    if (soon.length) {
        parts.push(locale === "pt" ? `Em breve: ${list(soon, "pt")}` : `Coming soon: ${list(soon, "en")}`);
    }
    if (planned.length) {
        parts.push(
            locale === "pt" ? `Em estudo: ${list(planned, "pt")}` : `Planned: ${list(planned, "en")}`
        );
    }
    return parts.join(". ") + ".";
}
