import { getRequestContext } from "@cloudflare/next-on-pages";
import { NextRequest, NextResponse } from "next/server";
import { RIOKO_CONFIG } from "@/lib/config";
import { getStripeEnvOptional } from "@/lib/stripe";
import { newOAuthState } from "@/lib/oauth-state";
import { isStripeConnectEnabled, resolveTargetUser, stripeConnectRedirectUri } from "@/lib/stripe-connect";

export const runtime = "edge";

/**
 * Step 1 of the one-click Stripe connection: mint the consent URL.
 *
 * `scope=read_only` on purpose. Everything the invoicing needs — PaymentIntents,
 * Charges, Customers, Checkout Sessions, Invoices — is a read, and events arrive
 * on the platform's single Connect webhook endpoint rather than one we install
 * on the merchant's account. Asking for `read_write` would show them a consent
 * screen that says we can "create new payments and take other actions for you",
 * which would be both alarming and untrue.
 */
export async function POST(request: NextRequest) {
    if (!isStripeConnectEnabled()) return NextResponse.json({ error: "Disabled" }, { status: 404 });

    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const clientId = getStripeEnvOptional("STRIPE_CONNECT_CLIENT_ID");
    if (!clientId) {
        return NextResponse.json({ error: "STRIPE_CONNECT_CLIENT_ID not configured" }, { status: 500 });
    }

    const body = await request.json().catch(() => ({})) as { destination_kind?: string };
    const destinationKind = body.destination_kind === "invoicexpress" ? "invoicexpress" : "moloni";

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    const { state, expiresAt } = newOAuthState();
    const now = new Date().toISOString();

    // The row is created BEFORE the merchant leaves, because the state has to
    // live somewhere it will still be when they come back — possibly in another
    // tab, possibly ten minutes later.
    await db.prepare(
        `INSERT INTO connections
           (id, user_id, source_kind, destination_kind, source_config_json, status, oauth_state, oauth_state_expires_at, created_at, updated_at)
         VALUES (?, ?, 'stripe_connect', ?, ?, 'draft', ?, ?, ?, ?)
         ON CONFLICT(user_id, source_kind, destination_kind) DO UPDATE SET
           oauth_state = excluded.oauth_state,
           oauth_state_expires_at = excluded.oauth_state_expires_at,
           updated_at = excluded.updated_at`
    ).bind(
        crypto.randomUUID(), authResult.targetUserId, destinationKind,
        JSON.stringify({ auth_mode: "connect" }),
        state, expiresAt, now, now,
    ).run();

    const url = new URL("https://connect.stripe.com/oauth/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("scope", "read_only");
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", stripeConnectRedirectUri());

    return NextResponse.json({ authorize_url: url.toString() });
}
