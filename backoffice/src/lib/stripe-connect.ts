import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
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
