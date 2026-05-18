import Stripe from "stripe";
import { getRequestContext } from "@cloudflare/next-on-pages";

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
    if (_stripe) return _stripe;

    const key = process.env.STRIPE_SECRET_KEY
        || ((): string | undefined => {
            try { return (getRequestContext().env as any).STRIPE_SECRET_KEY; }
            catch { return undefined; }
        })();

    if (!key) throw new Error("STRIPE_SECRET_KEY not configured");

    _stripe = new Stripe(key, {
        apiVersion: "2025-01-27.acacia" as any,
        httpClient: Stripe.createFetchHttpClient(),
    });
    return _stripe;
}

export function getStripeEnv(name: string): string {
    const v = process.env[name] || ((): string | undefined => {
        try { return (getRequestContext().env as any)[name]; }
        catch { return undefined; }
    })();
    if (!v) throw new Error(`${name} not configured`);
    return v;
}

export function getStripeEnvOptional(name: string): string | undefined {
    return process.env[name] || ((): string | undefined => {
        try { return (getRequestContext().env as any)[name]; }
        catch { return undefined; }
    })();
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

export function isSubscriptionBlocked(sub: SubscriptionRow | null | undefined): boolean {
    if (!sub) return true;
    if (["canceled", "unpaid", "incomplete_expired", "past_due"].includes(sub.status)) return true;
    if (sub.status === "incomplete") return true;
    if (sub.status === "trialing" && sub.trial_end && new Date(sub.trial_end) < new Date()) return true;
    return false;
}

export function subscriptionUIState(sub: SubscriptionRow | null | undefined): "active" | "trialing_earlybird" | "trialing" | "blocked" | "none" {
    if (!sub) return "none";
    if (sub.status === "active") return "active";
    if (sub.status === "trialing") {
        const expired = sub.trial_end && new Date(sub.trial_end) < new Date();
        if (expired) return "blocked";
        return sub.early_bird ? "trialing_earlybird" : "trialing";
    }
    return "blocked";
}
