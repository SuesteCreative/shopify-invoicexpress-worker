
/**
 * The platforms a merchant can pick between, and where each pair is configured.
 *
 * One catalogue, two readers: the integrations page inside the dashboard and
 * the general onboarding a new client lands on after signing up. They used to
 * be the same lists written twice, which is how a pair could be offered in one
 * place and lead to a 404 in the other.
 *
 * Adding a platform or a pair is an edit to THIS file. Nothing else needs to
 * know — in particular, the day a Shopify or Lodgify onboarding exists, adding
 * one line to ONBOARDING_PATHS is what makes the general onboarding start
 * routing to it.
 */

export type PlatformIconName = "store" | "card" | "wallet" | "bank" | "clipboard";

export interface Platform {
    /** The stored `source_kind` / `destination_kind`, never a label. */
    id: string;
    name: string;
    /**
     * WHICH icon, never the icon itself. This catalogue is imported by tests
     * that run from the repo root, where only the worker's dependencies are
     * installed — pulling `lucide-react` in here made `npm test` fail to even
     * load the suite, which is what stopped the worker deploying for 12 hours
     * on 2026-09-11. Components resolve the name through <PlatformIcon>.
     */
    icon: PlatformIconName;
    logo: string | null;
    logoW: number;
    logoH: number;
    active: boolean;
}

// Ships dark until the platform is live on Rioko's Stripe account, exactly like
// the payment providers we have not built yet. NEXT_PUBLIC_ is inlined at build
// time, so this is a constant in the browser bundle.
export const STRIPE_CONNECT_ENABLED = process.env.NEXT_PUBLIC_STRIPE_CONNECT_ENABLED === "1";

export const PAYMENT_PLATFORMS: Platform[] = [
    { id: "shopify", name: "Shopify", icon: "store", logo: "/images/shopify-logo.webp", logoW: 28, logoH: 28, active: true },
    { id: "stripe", name: "Stripe Legacy", icon: "card", logo: "/images/stripe-logo.svg", logoW: 28, logoH: 28, active: true },
    // The same Stripe, connected in one click instead of by pasting a restricted
    // key. A separate tile because it is a separate connection: an account can
    // hold both, and support has to be able to tell which one is being discussed.
    { id: "stripe_connect", name: "Stripe Connect", icon: "card", logo: "/images/stripe-logo.svg", logoW: 28, logoH: 28, active: STRIPE_CONNECT_ENABLED },
    { id: "eupago", name: "EuPago", icon: "wallet", logo: "/images/eupago-logo.svg", logoW: 30, logoH: 30, active: true },
    { id: "lodgify", name: "Lodgify", icon: "wallet", logo: "/images/lodgify-logo-white.svg", logoW: 44, logoH: 12, active: true },
    { id: "easypay", name: "Easypay", icon: "wallet", logo: null, logoW: 0, logoH: 0, active: false },
    { id: "ifthenpay", name: "Ifthenpay", icon: "bank", logo: null, logoW: 0, logoH: 0, active: false },
];

export const INVOICING_PLATFORMS: Platform[] = [
    { id: "invoicexpress", name: "InvoiceXpress", icon: "clipboard", logo: "/images/invoicexpress_logo2.png", logoW: 30, logoH: 30, active: true },
    { id: "moloni", name: "Moloni", icon: "clipboard", logo: "/images/moloni-logo.svg", logoW: 30, logoH: 30, active: true },
    { id: "vendus", name: "Vendus", icon: "clipboard", logo: "/images/vendus-logo.svg", logoW: 30, logoH: 30, active: true },
];

export function platformName(id: string | null | undefined): string {
    if (!id) return "";
    const found = [...PAYMENT_PLATFORMS, ...INVOICING_PLATFORMS].find(p => p.id === id);
    return found?.name ?? id;
}

export function paymentPlatform(id: string | null | undefined): Platform | undefined {
    return PAYMENT_PLATFORMS.find(p => p.id === id);
}

export function invoicingPlatform(id: string | null | undefined): Platform | undefined {
    return INVOICING_PLATFORMS.find(p => p.id === id);
}

const pairKey = (source: string, destination: string) => `${source}:${destination}`;

/** The step-by-step configurator inside the dashboard, per pair. */
const CONFIGURATOR_PATHS: Record<string, string> = {
    "shopify:invoicexpress": "/integrations/shopify-ix",
    "shopify:moloni": "/integrations/shopify-moloni",
    "shopify:vendus": "/integrations/shopify-vendus",
    "stripe:invoicexpress": "/integrations/stripe-ix",
    "stripe:moloni": "/integrations/stripe-moloni",
    "stripe:vendus": "/integrations/stripe-vendus",
    "stripe_connect:invoicexpress": "/integrations/stripe-connect-ix",
    "stripe_connect:moloni": "/integrations/stripe-connect-moloni",
    "eupago:invoicexpress": "/integrations/eupago-ix",
    "lodgify:invoicexpress": "/integrations/lodgify-ix",
    "lodgify:moloni": "/integrations/lodgify-moloni",
    "lodgify:vendus": "/integrations/lodgify-vendus",
};

/**
 * The full-screen guided onboarding, for the pairs that have one.
 *
 * Deliberately a different list from the configurators: these pages carry the
 * whole flow, sign-up included, and are written for someone who has never seen
 * the dashboard. A pair that is missing here is not broken, it just hands the
 * merchant over to the dashboard instead.
 */
const ONBOARDING_PATHS: Record<string, string> = {
    "stripe_connect:invoicexpress": "/onboarding/stripe-connect-ix",
    "stripe_connect:moloni": "/onboarding/stripe-connect-moloni",
    "lodgify:invoicexpress": "/onboarding/lodgify-ix",
    "lodgify:moloni": "/onboarding/lodgify-moloni",
};

/** Stripe Connect is behind a flag: an unset flag makes its pairs unreachable. */
function pairEnabled(source: string): boolean {
    return source !== "stripe_connect" || STRIPE_CONNECT_ENABLED;
}

/** The configurator for this pair, or null when the pair cannot be set up. */
export function configuratorPath(source: string | null, destination: string | null): string | null {
    if (!source || !destination || !pairEnabled(source)) return null;
    return CONFIGURATOR_PATHS[pairKey(source, destination)] ?? null;
}

/** The guided onboarding for this pair, or null when it does not have one yet. */
export function onboardingPath(source: string | null, destination: string | null): string | null {
    if (!source || !destination || !pairEnabled(source)) return null;
    return ONBOARDING_PATHS[pairKey(source, destination)] ?? null;
}

/**
 * Every pair that has a guided page, for the panel that hands these links out.
 *
 * Derived from the map above rather than typed out again: the admin page used
 * to keep its own list, and it still advertised one page after three more had
 * been built.
 */
export function guidedOnboardings(): { source: string; destination: string; path: string }[] {
    return Object.keys(ONBOARDING_PATHS)
        .map(key => {
            const [source, destination] = key.split(":");
            return { source, destination, path: onboardingPath(source, destination) ?? "" };
        })
        .filter(entry => entry.path !== "");
}

/** True when the two platforms can actually be connected to each other. */
export function canConnectPair(source: string | null, destination: string | null): boolean {
    return configuratorPath(source, destination) !== null;
}

/**
 * Where the general onboarding puts the merchant down once the pair is chosen.
 *
 * The guided page when the pair has one; otherwise straight into the app, on
 * the configurator for exactly that pair. Never the bare dashboard while we
 * know which two platforms they came to join: that is the one landing where
 * they would have to pick the pair a second time to find their own setup.
 */
export function afterOnboardingPath(source: string | null, destination: string | null): string {
    return onboardingPath(source, destination) ?? configuratorPath(source, destination) ?? "/dashboard";
}
