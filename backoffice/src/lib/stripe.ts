import Stripe from "stripe";
import { getRequestContext } from "@cloudflare/next-on-pages";

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

export function getDB() {
    return (getRequestContext().env as any).DB as D1Database;
}

export interface SubscriptionRow {
    user_id: string;
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

// Gate purely on Stripe status. Trust Stripe to transition trialing → active|past_due|unpaid.
// Reason: gating on local trial_end timestamp creates a fragile window at exactly midnight
// where Stripe is processing the first invoice but local check would already block.
export function isSubscriptionBlocked(sub: SubscriptionRow | null | undefined): boolean {
    if (!sub) return true;
    if (["canceled", "unpaid", "incomplete_expired", "past_due", "incomplete"].includes(sub.status)) return true;
    // For backfilled early-bird rows that never had a Stripe sub (stripe_subscription_id IS NULL),
    // we still allow access while status='trialing' and trial_end is in the future.
    // If trial_end is in the past and there's no Stripe sub, it means the user never added a payment method
    // — block.
    if (sub.status === "trialing" && !sub.stripe_subscription_id) {
        if (sub.trial_end && new Date(sub.trial_end) < new Date()) return true;
    }
    return false;
}

export function subscriptionUIState(sub: SubscriptionRow | null | undefined): "active" | "trialing_earlybird" | "trialing" | "blocked" | "none" | "exempt" {
    if (!sub) return "none";
    if (sub.status === "exempt") return "exempt";
    if (sub.status === "active") return "active";
    if (sub.status === "trialing") {
        // For backfilled rows w/o Stripe sub: trial expiry blocks UI
        const expired = !sub.stripe_subscription_id && sub.trial_end && new Date(sub.trial_end) < new Date();
        if (expired) return "blocked";
        return sub.early_bird ? "trialing_earlybird" : "trialing";
    }
    return "blocked";
}
