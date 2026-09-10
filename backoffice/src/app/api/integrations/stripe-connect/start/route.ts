import { getRequestContext } from "@cloudflare/next-on-pages";
import { NextRequest, NextResponse } from "next/server";
import { RIOKO_CONFIG } from "@/lib/config";
import { newOAuthState } from "@/lib/oauth-state";
import { normalizeReturnSlug, RETURN_SLUG_WIZARD } from "@/lib/oauth-return";
import { isStripeConnectEnabled, resolveTargetUser, stripeConnectRedirectUri, stripeConnectCredentials } from "@/lib/stripe-connect";
import { isSuperAdmin } from "@/lib/admin";

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

    const body = await request.json().catch(() => ({})) as {
        destination_kind?: string; return_slug?: string; return_locale?: string; mode?: string;
    };
    const destinationKind = body.destination_kind === "invoicexpress" ? "invoicexpress" : "moloni";

    // Which page this round trip started on, so the callback can end it there.
    // Always written, never inherited: a row left over from a run that started
    // on the onboarding page would otherwise send a wizard user somewhere they
    // did not come from.
    const returnSlug = normalizeReturnSlug(body.return_slug) ?? RETURN_SLUG_WIZARD;
    const returnLocale = body.return_locale === "en" ? "en" : "pt";

    // Test mode is an operator tool, not a merchant choice: a sandbox
    // connection issues nothing certified and exists to exercise the flow.
    const wantsTest = body.mode === "test";
    if (wantsTest && !(await isSuperAdmin(authResult.userId))) {
        return NextResponse.json({ error: "Test mode is restricted" }, { status: 403 });
    }
    const mode = wantsTest ? "test" as const : "live" as const;
    const { clientId } = stripeConnectCredentials(mode);
    if (!clientId) {
        return NextResponse.json(
            { error: mode === "test" ? "STRIPE_CONNECT_CLIENT_ID_TEST not configured" : "STRIPE_CONNECT_CLIENT_ID not configured" },
            { status: 500 },
        );
    }

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
           source_config_json = json_patch(COALESCE(connections.source_config_json, '{}'), excluded.source_config_json),
           oauth_state = excluded.oauth_state,
           oauth_state_expires_at = excluded.oauth_state_expires_at,
           updated_at = excluded.updated_at`
    ).bind(
        crypto.randomUUID(), authResult.targetUserId, destinationKind,
        // Patched, not replaced, on an existing row: a reconnection must not drop
        // the account id this same column is holding.
        //
        // `livemode` is provisional — the callback needs to know which secret key
        // to exchange with BEFORE Stripe has told it anything, and Stripe's own
        // answer overwrites it with the truth a moment later.
        JSON.stringify({ auth_mode: "connect", return_slug: returnSlug, return_locale: returnLocale, livemode: mode === "live" }),
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
