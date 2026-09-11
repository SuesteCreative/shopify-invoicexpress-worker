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
    amountCents: number;
    interval: "month" | "year";
}

export function requiredPrices(): RequiredPrice[] {
    const out: RequiredPrice[] = [];

    for (const [connectionKey, source] of Object.entries(CONNECTION_KEY_TO_SOURCE)) {
        const [src, dest] = connectionKey.split(":");
        const productName = `Rioko 2.0 || ${PRODUCT_LABEL[src] ?? src} - ${PRODUCT_LABEL[dest] ?? dest}`;

        for (const plan of ["monthly", "annual"] as const) {
            let lookup: string | null = null;
            try {
                lookup = priceLookupFor(source, plan);
            } catch {
                // The Shopify pair reads its keys from the environment and
                // getStripeEnv throws when one is unset. That is itself the
                // answer: nothing can resolve.
                lookup = null;
            }
            out.push({
                connectionKey,
                source,
                plan,
                lookup,
                productName,
                amountCents: plan === "annual" ? CURRENT_ANNUAL_CENTS : CURRENT_MONTHLY_CENTS,
                interval: plan === "annual" ? "year" : "month",
            });
        }
    }

    return out.sort((a, b) =>
        a.productName.localeCompare(b.productName) || a.plan.localeCompare(b.plan));
}

export type PriceStatus = "ok" | "archived" | "missing" | "no_key";

/** What the catalogue says about one required price, given the price book. */
export function statusOf(req: RequiredPrice, price: any | null | undefined): PriceStatus {
    if (!req.lookup) return "no_key";
    if (!price) return "missing";
    return price.active === false ? "archived" : "ok";
}
