import { getRequestContext } from "@cloudflare/next-on-pages";
import { NextRequest, NextResponse } from "next/server";
import { RIOKO_CONFIG } from "@/lib/config";
import { getStripeEnvOptional } from "@/lib/stripe";
import { newOAuthState } from "@/lib/oauth-state";
import { isStripeConnectEnabled, resolveTargetUser, moloniRedirectUri } from "@/lib/stripe-connect";

export const runtime = "edge";

/** Moloni's consent page. Not on api.moloni.pt — that host only mints tokens. */
const MOLONI_AUTHORIZE_URL = "https://www.moloni.pt/ac/root/oauth/";

/**
 * The URL the merchant pastes into the *Redirect URI* field of their Moloni
 * developer app. One per connection, so the callback knows whose code it is
 * holding without trusting anything in the query string.
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

    const redirectUri = moloniRedirectUri(row.id);
    const url = new URL(MOLONI_AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);

    return NextResponse.json({
        authorize_url: url.toString(),
        // Echoed back so the wizard can show the merchant the exact string to
        // paste into Moloni — it must match byte for byte or Moloni refuses.
        redirect_uri: redirectUri,
        connection_id: row.id,
    });
}
