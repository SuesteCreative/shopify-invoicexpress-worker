import { priceLookupFor, type BillingPlan } from "./billing-prices";
import { CONNECTION_KEY_TO_SOURCE } from "./subscription-key";

/**
 * Every price the checkout can ask Stripe for, and what it should look like if
 * it has to be created.
 *
 * A merchant who picks a pair whose price was never created gets a 500 at the
 * moment they try to pay, and nothing before that point says so — the pair
 * looks configurable right up to the card form. Stripe→Moloni monthly was
 * exactly that for months.
 *
 * The product names are written out rather than taken from `kindLabel`, because
 * the two vocabularies disagree on purpose: the console says "Stripe Legacy"
 * and "IX API" to tell one connection from another, while Stripe's product is
 * what a client reads on an invoice and has always said "Stripe" and
 * "InvoiceXpress". Renaming a live product to match an internal label would
 * change what appears on their receipts.
 */

/** How a pair is named on a Stripe product, and therefore on an invoice. */
const PRODUCT_LABEL: Record<string, string> = {
    shopify: "Shopify",
    stripe: "Stripe",
    stripe_connect: "Stripe Connect",
    lodgify: "Lodgify",
    eupago: "EuPago",
    invoicexpress: "InvoiceXpress",
    moloni: "Moloni",
    vendus: "Vendus",
};

/** The current plan, net of VAT. Stripe holds prices exclusive of tax and the
 *  checkout attaches the tax rate, so these are 7,50 € and 75 € before IVA. */
export const CURRENT_MONTHLY_CENTS = 750;
export const CURRENT_ANNUAL_CENTS = 7500;

/**
 * The rest of what a Rioko product looks like in Stripe.
 *
 * Written down because this Stripe account is shared: it holds ~490 objects
 * belonging to another billing system, some of them named after the merchant
 * they were created for. A product that carries our tax code, our image and
 * `metadata.app = "rioko"` can be told from those at a glance and by a script.
 *
 * The image is served from the app's own `public/images`, the way the email
 * templates already do it — Stripe fetches the URL once and caches its own copy.
 */
export const PRODUCT_TAX_CODE = "txcd_20030000";
export const PRODUCT_IMAGE_URL = "https://rioko.online/images/rioko-product.png";

/** The bilingual line the first Rioko product carries, said about any pair. */
export function productDescription(sourceLabel: string, destinationLabel: string): string {
    return `A próxima geração de integrações Kapta, liga de forma integrada o ${sourceLabel} ao ${destinationLabel} para uma faturação totalmente automatizada.`
        + ` || The next generation of Kapta integrations, seamlessly connecting ${sourceLabel} with ${destinationLabel} for fully automated invoicing.`;
}

export interface RequiredPrice {
    /** `<source_kind>:<destination_kind>` — what a subscription row stores. */
    connectionKey: string;
    /** The billing `source` the checkout speaks in. */
    source: string;
    plan: BillingPlan;
    /** What Stripe should be asked for. Null when the pair has no key at all. */
    lookup: string | null;
    /** "Rioko 2.0 || Stripe - Moloni" */
    productName: string;
    /** The bilingual description that product should carry. */
    productDescription: string;
    amountCents: number;
    interval: "month" | "year";
}

export function requiredPrices(): RequiredPrice[] {
    const out: RequiredPrice[] = [];

    for (const [connectionKey, source] of Object.entries(CONNECTION_KEY_TO_SOURCE)) {
        const [src, dest] = connectionKey.split(":");
        const srcLabel = PRODUCT_LABEL[src] ?? src;
        const destLabel = PRODUCT_LABEL[dest] ?? dest;
        const productName = `Rioko 2.0 || ${srcLabel} - ${destLabel}`;

        for (const plan of ["monthly", "annual"] as const) {
            const lookup = priceLookupFor(source, plan);
            out.push({
                connectionKey,
                source,
                plan,
                lookup,
                productName,
                productDescription: productDescription(srcLabel, destLabel),
                amountCents: plan === "annual" ? CURRENT_ANNUAL_CENTS : CURRENT_MONTHLY_CENTS,
                interval: plan === "annual" ? "year" : "month",
            });
        }
    }

    return out.sort((a, b) =>
        a.productName.localeCompare(b.productName) || a.plan.localeCompare(b.plan));
}

export type PriceStatus = "ok" | "archived" | "missing" | "no_key" | "wrong_amount";

/**
 * What the catalogue says about one required price, given the price book.
 *
 * The amount is checked, not just the existence. Until it was, `stripe-ix-*`
 * and `stripe-moloni-*` sat at 5 €/50 € for months and reported `ok`, because
 * they were the same two keys the old plan borrowed — so every merchant who
 * subscribed those two pairs was quoted, and charged, the old price
 * (found 12/09/2026).
 */
export function statusOf(req: RequiredPrice, price: any | null | undefined): PriceStatus {
    if (!req.lookup) return "no_key";
    if (!price) return "missing";
    if (price.active === false) return "archived";
    if (typeof price.unit_amount === "number" && price.unit_amount !== req.amountCents) return "wrong_amount";
    return "ok";
}
