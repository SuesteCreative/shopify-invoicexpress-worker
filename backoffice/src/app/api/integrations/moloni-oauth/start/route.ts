import { getRequestContext } from "@cloudflare/next-on-pages";
import { NextRequest, NextResponse } from "next/server";
import { RIOKO_CONFIG } from "@/lib/config";
import { getStripeEnvOptional } from "@/lib/stripe";
import { newOAuthState } from "@/lib/oauth-state";
import { isStripeConnectEnabled, resolveTargetUser } from "@/lib/stripe-connect";
import { moloniCallbackUri } from "@/lib/moloni-oauth";

export const runtime = "edge";

/** Moloni's consent page. Not on api.moloni.pt — that host only mints tokens. */
const MOLONI_AUTHORIZE_URL = "https://www.moloni.pt/ac/root/oauth/";

/**
 * Saves the merchant's Moloni developer credentials and returns the consent URL.
 *
 * The credentials are still typed by hand because Moloni's documentation
 * describes the redirect flow for plugins installed on many sites but never
 * states that one developer app may authorise third-party accounts.
 */
export async function POST(request: NextRequest) {
    if (!isStripeConnectEnabled()) return NextResponse.json({ error: "Disabled" }, { status: 404 });

    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const body = await request.json().catch(() => ({})) as {
        client_id?: string;
        client_secret?: string;
        environment?: string;
    };

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    const row: any = await db
        .prepare(`SELECT id, destination_config_json FROM connections
                   WHERE user_id = ? AND source_kind = 'stripe_connect' LIMIT 1`)
        .bind(authResult.targetUserId)
        .first();
    if (!row) {
        return NextResponse.json({ error: "Ligue primeiro o Stripe." }, { status: 404 });
    }

    const stored = row.destination_config_json ? JSON.parse(row.destination_config_json) : {};
    const clientId = (body.client_id ?? "").trim() || stored.moloni_client_id
        || getStripeEnvOptional("MOLONI_APP_CLIENT_ID");
    const clientSecret = (body.client_secret ?? "").trim() || stored.moloni_client_secret
        || getStripeEnvOptional("MOLONI_APP_CLIENT_SECRET");

    if (!clientId || !clientSecret) {
        return NextResponse.json({ error: "Faltam o Developer ID e o Client Secret do Moloni." }, { status: 400 });
    }

    const { state, expiresAt } = newOAuthState();
    const now = new Date().toISOString();
    const patch: Record<string, any> = {
        moloni_auth_mode: "oauth",
        moloni_client_id: clientId,
        moloni_client_secret: clientSecret,
        // Cleared here so a re-authorisation after a failure does not leave the
        // old complaint on screen.
        moloni_oauth_error: null,
    };
    if (body.environment === "sandbox" || body.environment === "production") {
        patch.moloni_environment = body.environment;
    }

    await db.prepare(
        `UPDATE connections
            SET destination_config_json = json_patch(COALESCE(destination_config_json, '{}'), ?),
                oauth_state = ?, oauth_state_expires_at = ?, updated_at = ?
          WHERE id = ?`
    ).bind(JSON.stringify(patch), state, expiresAt, now, row.id).run();

    // The same URL for every merchant and every connection: a Moloni developer
    // app holds exactly one callback, so a URL that changed per connection was a
    // "redirect_uri não coincide" waiting to happen the second time anyone used
    // it. Which connection the code belongs to is decided in the callback.
    const redirectUri = moloniCallbackUri();
    const url = new URL(MOLONI_AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    // Moloni is not documented as echoing this back. It costs nothing to send,
    // and the callback names the connection outright whenever it does come back.
    url.searchParams.set("state", state);

    return NextResponse.json({
        authorize_url: url.toString(),
        // Echoed back so the wizard can show the merchant the exact string to
        // paste into Moloni — it must match byte for byte or Moloni refuses.
        redirect_uri: redirectUri,
        connection_id: row.id,
    });
}
