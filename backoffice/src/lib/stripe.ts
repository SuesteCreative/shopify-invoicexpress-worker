import Stripe from "stripe";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { DEFAULT_CONNECTION_KEY, shopIsOldest } from "./subscription-key";

function readEnv(name: string): string | undefined {
    // process.env works for plaintext on next-on-pages
    const fromProc = process.env[name];
    if (fromProc) return fromProc;
    // Bindings + secrets resolve via getRequestContext().env
    try {
        const ctx = getRequestContext();
        const v = (ctx?.env as any)?.[name];
        if (v) return v as string;
    } catch { /* not in request scope */ }
    return undefined;
}

export function getStripe(): Stripe {
    const key = readEnv("STRIPE_SECRET_KEY");
    if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
    return new Stripe(key, {
        apiVersion: "2025-01-27.acacia" as any,
        httpClient: Stripe.createFetchHttpClient(),
    });
}

export function getStripeEnv(name: string): string {
    const v = readEnv(name);
    if (!v) throw new Error(`${name} not configured`);
    return v;
}

export function getStripeEnvOptional(name: string): string | undefined {
    return readEnv(name);
}

export function subscriptionPerConnectionEnforced(): boolean {
    return readEnv("SUBSCRIPTION_PER_CONNECTION") === "1"
        || process.env.NEXT_PUBLIC_SUBSCRIPTION_PER_CONNECTION === "1";
}

export function getDB() {
    return (getRequestContext().env as any).DB as D1Database;
}

export interface SubscriptionRow {
    user_id: string;
    /** `<source_kind>:<destination_kind>` — which connection this pays for (0044). */
    connection_key: string;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    status: string;
    plan: string | null;
    price_id: string | null;
    current_period_end: string | null;
    trial_end: string | null;
    cancel_at_period_end: number;
    early_bird: number;
    nif: string | null;
    name: string | null;
    email: string | null;
    phone: string | null;
    address: string | null;
    city: string | null;
    zip: string | null;
    country: string | null;
    created_at: string;
    updated_at: string;
}

/**
 * Every subscription on the account, newest first.
 *
 * There can be more than one since 0044: an account running a Shopify shop and
 * a Stripe account pays for each. Callers that need "the" subscription of a
 * connection use `pickSubscription`; callers showing the account as a whole
 * (the invoice list, the customer record) read them all.
 */
export async function listSubscriptions(db: D1Database, userId: string): Promise<SubscriptionRow[]> {
    const rows = await db.prepare(
        "SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC"
    ).bind(userId).all();
    return (rows.results ?? []) as unknown as SubscriptionRow[];
}

/**
 * The subscription that pays for one connection.
 *
 * No fallback to "any subscription on the account" — that fallback IS the bug
 * this replaces. A connection with no row of its own is not covered, and the
 * caller decides what that means (the gate blocks; the UI offers checkout).
 */
export function pickSubscription(rows: SubscriptionRow[], connectionKey: string): SubscriptionRow | null {
    return rows.find((r) => r.connection_key === connectionKey) ?? null;
}

/**
 * The connection a billing question is about when the caller did not say.
 *
 * The account's oldest integration — a Shopify shop older than any connection
 * wins over them, same rule as migration 0044 and the Stripe webhook, so all
 * three agree on which connection an unattributed subscription belongs to.
 */
export async function primaryConnectionKey(db: D1Database, userId: string): Promise<string> {
    const conn: any = await db.prepare(
        "SELECT source_kind, destination_kind, created_at FROM connections WHERE user_id = ? ORDER BY created_at ASC LIMIT 1"
    ).bind(userId).first();
    const shop: any = await db.prepare(
        "SELECT created_at FROM integrations WHERE user_id = ? AND shopify_domain IS NOT NULL AND shopify_domain <> '' LIMIT 1"
    ).bind(userId).first();
    if (shop && shopIsOldest(shop.created_at, conn?.created_at)) return DEFAULT_CONNECTION_KEY;
    if (conn) return `${conn.source_kind}:${conn.destination_kind}`;
    return DEFAULT_CONNECTION_KEY;
}

/**
 * Every connection on the account, whether or not it has a `connections` row.
 *
 * The legacy Shopify integration does not have one and is invisible to any
 * query over that table — which is exactly how it came to invoice for free on
 * another connection's subscription.
 */
export async function listAccountConnections(
    db: D1Database, userId: string,
): Promise<{ key: string; source_kind: string; destination_kind: string; status: string }[]> {
    const out: { key: string; source_kind: string; destination_kind: string; status: string }[] = [];
    const shop: any = await db.prepare(
        "SELECT shopify_domain, is_paused FROM integrations WHERE user_id = ? AND shopify_domain IS NOT NULL AND shopify_domain <> '' LIMIT 1"
    ).bind(userId).first();
    if (shop) {
        out.push({
            key: DEFAULT_CONNECTION_KEY, source_kind: "shopify", destination_kind: "invoicexpress",
            status: shop.is_paused ? "paused" : "active",
        });
    }
    const rows = await db.prepare(
        "SELECT source_kind, destination_kind, status FROM connections WHERE user_id = ? ORDER BY created_at ASC"
    ).bind(userId).all();
    for (const r of (rows.results ?? []) as any[]) {
        const key = `${r.source_kind}:${r.destination_kind}`;
        if (out.some((c) => c.key === key)) continue;
        out.push({ key, source_kind: r.source_kind, destination_kind: r.destination_kind, status: r.status });
    }
    return out;
}

// Gate purely on Stripe status. Trust Stripe to transition trialing → active|past_due|unpaid.
// Reason: gating on local trial_end timestamp creates a fragile window at exactly midnight
// where Stripe is processing the first invoice but local check would already block.
export function isSubscriptionBlocked(sub: SubscriptionRow | null | undefined): boolean {
    if (!sub) return true;
    if (["canceled", "unpaid", "incomplete_expired", "past_due", "incomplete"].includes(sub.status)) return true;
    // Must pay to run: while trialing without a Stripe sub, only early-bird users
    // inside their trial window keep access. Non-early-bird (or an expired
    // early-bird trial) is suspended — they must subscribe to activate.
    if (sub.status === "trialing" && !sub.stripe_subscription_id) {
        const earlyBirdActive = !!sub.early_bird && !!sub.trial_end && new Date(sub.trial_end) > new Date();
        if (!earlyBirdActive) return true;
    }
    return false;
}

export function subscriptionUIState(sub: SubscriptionRow | null | undefined): "active" | "trialing_earlybird" | "trialing" | "blocked" | "none" | "exempt" {
    if (!sub) return "none";
    if (sub.status === "exempt") return "exempt";
    if (sub.status === "active") return "active";
    if (sub.status === "trialing") {
        if (sub.stripe_subscription_id) return "trialing";  // paying inside a Stripe trial
        // Only early-bird users inside their window keep trial access; everyone
        // else (non-early-bird, or expired early-bird) is suspended → blocked.
        if (sub.early_bird && sub.trial_end && new Date(sub.trial_end) > new Date()) return "trialing_earlybird";
        return "blocked";
    }
    return "blocked";
}

/**
 * Embedded Checkout speaks a newer API than the one this client pins.
 *
 * The browser SDK mounts it with `createEmbeddedCheckoutPage`, which only
 * understands a session created with `ui_mode: "embedded_page"`. That value does
 * not exist before this API version, and the older `embedded` no longer exists
 * after it — send the wrong pair and the form mounts as an empty box, with
 * nothing in the console to say why. Passed per request, so every other call
 * stays on the pinned version.
 */
export const EMBEDDED_CHECKOUT_API_VERSION = "2026-04-22.dahlia";
export const EMBEDDED_CHECKOUT_UI_MODE = "embedded_page";
