import { auth } from "@clerk/nextjs/server";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { NextRequest } from "next/server";
import { callWorkerJson } from "@/lib/worker";
import { resolveAccountUser } from "@/lib/account";
import { getStripeEnvOptional } from "@/lib/stripe";
import { RIOKO_CONFIG } from "@/lib/config";

/**
 * Shared pieces of the Stripe Connect and Moloni OAuth flows.
 *
 * They lived on the route modules that happened to define them first, and the
 * routes imported each other. Next.js only allows a route file to export the
 * HTTP handlers and a short list of config values, so every extra export made
 * `next build` generate a type it then rejected — invisible in production
 * because `ignoreBuildErrors` is on, and noisy in every local typecheck. A
 * shared helper belongs in lib, not in whichever endpoint needed it first.
 */

export function isStripeConnectEnabled(): boolean {
    // NEXT_PUBLIC_ is inlined at build time; the other spelling is a Cloudflare
    // var, which only `getStripeEnvOptional` can see.
    return process.env.NEXT_PUBLIC_STRIPE_CONNECT_ENABLED === "1"
        || getStripeEnvOptional("STRIPE_CONNECT_ENABLED") === "1";
}

export async function resolveTargetUser(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return { error: "Unauthorized", status: 401 as const };
    const targetUserId = await resolveAccountUser(request, userId);
    return { userId, targetUserId };
}

/** Where Stripe sends the merchant back. Registered in the Connect dashboard. */
export const STRIPE_CONNECT_REDIRECT_PATH = "/api/integrations/stripe-connect/callback";

export function stripeConnectRedirectUri(): string {
    return `${RIOKO_CONFIG.appUrl}${STRIPE_CONNECT_REDIRECT_PATH}`;
}

/**
 * The URL the merchant pastes into the *Redirect URI* field of their Moloni
 * developer app. One per connection, so the callback knows whose code it is
 * holding without trusting anything in the query string.
 */
export function moloniRedirectUri(connectionId: string): string {
    return `${RIOKO_CONFIG.appUrl}/api/integrations/moloni-oauth/callback/${connectionId}`;
}

/**
 * Stripe's Connect credentials come in pairs, one per mode.
 *
 * A test `client_id` exchanged with the live secret key is rejected, and a
 * test-mode `acct_` read with the live key answers 404 — so the mode has to be
 * consistent from the consent screen through to every later read.
 *
 * The test values are SEPARATE variables, never a replacement for the live
 * ones: those are platform-wide, and swapping them would take every live
 * Connect merchant down at once. When they are unset — which is the normal
 * state — test mode simply is not offered.
 */
export type StripeMode = "live" | "test";

/**
 * Ask the worker to read this merchant's Stripe account the moment they go live.
 *
 * The worker and not here: only it holds `STRIPE_PLATFORM_SECRET_KEY`, and only
 * it can turn `stripe_tax_from_source` on from what it finds. Backgrounded
 * through `waitUntil`, because a merchant pressing "activate" should not wait
 * on two Stripe reads, and a probe that fails changes nothing — the nightly
 * sweep asks the same question again tomorrow.
 */
export function probeConnectionTaxInBackground(userId: string, destinationKind: string): void {
    const work = callWorkerJson("/admin/connection/tax-probe", {
        method: "POST",
        body: JSON.stringify({ user_id: userId, destination_kind: destinationKind }),
    }).catch(() => undefined);
    try {
        getRequestContext().ctx.waitUntil(work);
    } catch {
        // Outside a request scope (a build-time import, a test): let it run loose.
    }
}

export function stripeConnectCredentials(mode: StripeMode) {
    const suffix = mode === "test" ? "_TEST" : "";
    return {
        clientId: getStripeEnvOptional(`STRIPE_CONNECT_CLIENT_ID${suffix}`),
        // The token exchange authenticates with the platform's own secret key.
        secretKey: getStripeEnvOptional(`STRIPE_SECRET_KEY${suffix}`),
    };
}
