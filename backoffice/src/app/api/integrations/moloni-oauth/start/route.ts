import { getRequestContext } from "@cloudflare/next-on-pages";
import { NextRequest, NextResponse } from "next/server";
import { RIOKO_CONFIG } from "@/lib/config";
import { getStripeEnvOptional } from "@/lib/stripe";
import { newOAuthState } from "@/lib/oauth-state";
import { isStripeConnectEnabled, resolveTargetUser } from "@/lib/stripe-connect";
import { moloniCallbackUri } from "@/lib/moloni-oauth";
import { normalizeReturnSlug } from "@/lib/oauth-return";
import { sourceKindOrNull, unknownSourceKindError } from "@/lib/connection-kinds";

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
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const body = await request.json().catch(() => ({})) as {
        client_id?: string;
        client_secret?: string;
        environment?: string;
        source_kind?: string;
        return_slug?: string;
        return_locale?: string;
    };

    // Which of the merchant's connections is being authorised. It used to be
    // hardcoded to stripe_connect, which is why Lodgify could never reach
    // Moloni: the row exists, the flow just refused to look at it. Absent still
    // means stripe_connect, so every link already sent out keeps working.
    //
    // A NAMED kind now has to be one we know. Widening it to "lodgify or else
    // stripe_connect" left every other value pointing at the Connect row, so a
    // request naming `stripe` wrote that merchant's Moloni client id, client
    // secret and single-use `oauth_state` onto a connection they had not asked
    // to authorise — and the state is what the callback matches on.
    const sourceKind = sourceKindOrNull(body.source_kind, "stripe_connect");
    if (!sourceKind) return NextResponse.json({ error: unknownSourceKindError(body.source_kind) }, { status: 400 });

    // The kill switch belongs to Stripe Connect, not to Moloni. Flipping Connect
    // off must not take a Lodgify merchant's invoicing with it.
    if (sourceKind === "stripe_connect" && !isStripeConnectEnabled()) {
        return NextResponse.json({ error: "Disabled" }, { status: 404 });
    }

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    const row: any = await db
        .prepare(`SELECT id, destination_config_json FROM connections
                   WHERE user_id = ? AND source_kind = ? AND destination_kind = 'moloni' LIMIT 1`)
        .bind(authResult.targetUserId, sourceKind)
        .first();
    if (!row) {
        return NextResponse.json({
            error: sourceKind === "lodgify" ? "Ligue primeiro o Lodgify." : "Ligue primeiro o Stripe.",
        }, { status: 404 });
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

    // Where the callback puts the merchant down. The Stripe flow writes this
    // when it starts, so Moloni-only flows (Lodgify) had nothing to read and
    // every merchant came back on the Stripe wizard. A slug through the fixed
    // map in oauth-return, never a path from the request.
    const returnSlug = normalizeReturnSlug(body.return_slug);
    const sourcePatch = returnSlug
        ? JSON.stringify({ return_slug: returnSlug, return_locale: body.return_locale === "en" ? "en" : "pt" })
        : null;

    // One Moloni round trip in flight at a time, for this account.
    //
    // Moloni does not echo the `state` parameter back, so the callback cannot be
    // told which connection a code belongs to — it has to find the row whose
    // authorisation is in flight. With two in flight there is no honest answer,
    // and starting a second one left the first standing for its full fifteen
    // minutes: pressing "autorizar" again refreshed one and left the other, so
    // retrying — which is exactly what the error message tells the merchant to
    // do — could not get them out of it.
    //
    // The marker is `moloni_oauth_pending_at`, in this connection's own
    // destination config, NOT the shared `oauth_state` column. That column is
    // also the Stripe Connect round trip's, on the very same row for a
    // `stripe_connect → moloni` connection, so clearing it to disambiguate one
    // flow would silently break the other.
    await db.prepare(
        `UPDATE connections
            SET destination_config_json = json_patch(COALESCE(destination_config_json, '{}'), ?),
                updated_at = ?
          WHERE user_id = ? AND destination_kind = 'moloni' AND id <> ?
            AND json_extract(destination_config_json, '$.moloni_oauth_pending_at') IS NOT NULL`
    ).bind(JSON.stringify({ moloni_oauth_pending_at: null }), now, authResult.targetUserId, row.id).run();

    patch.moloni_oauth_pending_at = now;

    await db.prepare(
        `UPDATE connections
            SET destination_config_json = json_patch(COALESCE(destination_config_json, '{}'), ?),
                source_config_json = CASE WHEN ? IS NULL THEN source_config_json
                    ELSE json_patch(COALESCE(source_config_json, '{}'), ?) END,
                oauth_state = ?, oauth_state_expires_at = ?, updated_at = ?
          WHERE id = ?`
    ).bind(JSON.stringify(patch), sourcePatch, sourcePatch, state, expiresAt, now, row.id).run();

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
