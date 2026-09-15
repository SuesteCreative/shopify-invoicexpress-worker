import { getRequestContext } from "@cloudflare/next-on-pages";
import { NextRequest, NextResponse } from "next/server";
import { getStripeEnvOptional } from "@/lib/stripe";
import { newOAuthState } from "@/lib/oauth-state";
import { isStripeConnectEnabled, resolveTargetUser } from "@/lib/stripe-connect";
import { moloniCallbackUri } from "@/lib/moloni-oauth";
import { normalizeReturnSlug } from "@/lib/oauth-return";
import { sourceKindOrNull, unknownSourceKindError } from "@/lib/connection-kinds";

export const runtime = "edge";

/** Moloni's consent page. Not on api.moloni.pt — that host only mints tokens. */
const MOLONI_AUTHORIZE_URL = "https://www.moloni.pt/ac/root/oauth/";

/** What to tell a merchant who reached the Moloni step before the source step. */
const CONNECT_SOURCE_FIRST: Record<string, string> = {
    stripe: "Ligue primeiro o Stripe.",
    stripe_connect: "Ligue primeiro o Stripe.",
    lodgify: "Ligue primeiro o Lodgify.",
    eupago: "Ligue primeiro o EuPago.",
};

/**
 * Saves the merchant's Moloni developer credentials and returns the consent URL.
 *
 * Every Moloni connection authorises here, whichever door it came in through —
 * decision of 15/09/2026, replacing the 10/09 one that kept the dashboard wizards
 * on a username and password. The password grant survives only for the
 * connections that already had it; nothing here creates a new one.
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

    // Which of the merchant's connections is being authorised. Absent means
    // stripe_connect, so every link already sent out keeps working.
    //
    // A NAMED kind has to be one we know. This gate has been wrong three ways:
    // "lodgify or else stripe_connect" wrote a request naming `stripe` onto the
    // Connect row; the fix for that accepted any known kind while the decision
    // still kept three wizards on the password grant; and pinning it to two kinds
    // turned out to be the opposite of where the product was going. Every Moloni
    // connection authorises by OAuth now, so the only thing to refuse is a kind
    // that does not exist.
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

    const selectRow = () => db
        .prepare(`SELECT id, destination_config_json FROM connections
                   WHERE user_id = ? AND source_kind = ? AND destination_kind = 'moloni' LIMIT 1`)
        .bind(authResult.targetUserId, sourceKind)
        .first();

    let row: any = await selectRow();
    if (!row && sourceKind === "shopify") {
        // Shopify keeps its own credentials on the account's legacy row, so no
        // source step ever creates a `connections` row for this pair — and there
        // is nothing to authorise without one. The Stripe and Lodgify wizards
        // create theirs when the source is saved, which is why they still 404.
        const created = new Date().toISOString();
        await db.prepare(
            `INSERT INTO connections (id, user_id, source_kind, destination_kind, status, created_at, updated_at)
             VALUES (?, ?, 'shopify', 'moloni', 'draft', ?, ?)
             ON CONFLICT(user_id, source_kind, destination_kind) DO NOTHING`
        ).bind(crypto.randomUUID(), authResult.targetUserId, created, created).run();
        row = await selectRow();
    }
    if (!row) {
        return NextResponse.json({ error: CONNECT_SOURCE_FIRST[sourceKind] ?? "Ligue primeiro a origem." }, { status: 404 });
    }

    const stored = row.destination_config_json ? JSON.parse(row.destination_config_json) : {};

    // A second Moloni connection starts from the account's first.
    //
    // Same Moloni account means the same developer app, so the merchant is not
    // made to go and find a Client Secret that Moloni only ever shows once. The
    // APP is all that is borrowed: this connection still goes through its own
    // consent screen and holds its own token pair — tokens are never read from a
    // sibling, because a refresh token rotates on every use and two connections
    // sharing one would kill each other. Its fiscal settings are its own too, the
    // rule InvoiceXpress already follows (one account, two connections, two
    // different séries on 15/09/2026).
    const typedId = (body.client_id ?? "").trim();
    const typedSecret = (body.client_secret ?? "").trim();
    const needSibling = !(typedId || stored.moloni_client_id)
        || !(typedSecret || stored.moloni_client_secret)
        || !(body.environment || stored.moloni_environment);
    const sibling: any = needSibling
        ? await db.prepare(
            `SELECT json_extract(destination_config_json, '$.moloni_client_id')     AS client_id,
                    json_extract(destination_config_json, '$.moloni_client_secret') AS client_secret,
                    json_extract(destination_config_json, '$.moloni_environment')   AS environment
               FROM connections
              WHERE user_id = ? AND destination_kind = 'moloni' AND source_kind <> ?
                AND json_extract(destination_config_json, '$.moloni_client_id') IS NOT NULL
                AND json_extract(destination_config_json, '$.moloni_client_secret') IS NOT NULL
              ORDER BY updated_at DESC LIMIT 1`
        ).bind(authResult.targetUserId, sourceKind).first()
        : null;

    // Both halves from the same place. An id typed on this page with a secret
    // borrowed from a sibling would pair two different apps.
    const fromTyped = typedId && typedSecret ? { id: typedId, secret: typedSecret } : null;
    const fromStored = stored.moloni_client_id && (typedSecret || stored.moloni_client_secret)
        ? { id: typedId || stored.moloni_client_id, secret: typedSecret || stored.moloni_client_secret }
        : null;
    const fromSibling = sibling?.client_id && sibling?.client_secret && (!typedId || typedId === sibling.client_id)
        ? { id: String(sibling.client_id), secret: typedSecret || String(sibling.client_secret) }
        : null;
    const fromEnv = getStripeEnvOptional("MOLONI_APP_CLIENT_ID") && getStripeEnvOptional("MOLONI_APP_CLIENT_SECRET")
        ? { id: getStripeEnvOptional("MOLONI_APP_CLIENT_ID")!, secret: getStripeEnvOptional("MOLONI_APP_CLIENT_SECRET")! }
        : null;
    const app = fromTyped ?? fromStored ?? fromSibling ?? fromEnv;

    if (!app) {
        return NextResponse.json({ error: "Faltam o Developer ID e o Client Secret do Moloni." }, { status: 400 });
    }
    const clientId = app.id;
    const clientSecret = app.secret;

    const { state, expiresAt } = newOAuthState();
    const now = new Date().toISOString();

    // A connection still invoicing on a password keeps invoicing on it until
    // Moloni has actually handed back a token pair.
    //
    // The worker reads `moloni_auth_mode` alone to decide how to authenticate.
    // Writing it here, before the consent screen, would switch a working
    // connection to a token that does not exist yet: a merchant who pressed
    // "Mudar para OAuth" and closed the tab, or was refused by Moloni, would
    // stop being invoiced with nothing on screen to say so. The new app waits
    // in `moloni_pending_*` instead, and the callback promotes it only once the
    // exchange has succeeded.
    const fromPassword = !!stored.moloni_password && !stored.moloni_refresh_token;
    const patch: Record<string, any> = fromPassword
        ? { moloni_pending_client_id: clientId, moloni_pending_client_secret: clientSecret }
        : { moloni_auth_mode: "oauth", moloni_client_id: clientId, moloni_client_secret: clientSecret };
    // Cleared here so a re-authorisation after a failure does not leave the old
    // complaint on screen.
    patch.moloni_oauth_error = null;
    const environment = body.environment === "sandbox" || body.environment === "production"
        ? body.environment
        : (stored.moloni_environment ? undefined : sibling?.environment);
    if (environment === "sandbox" || environment === "production") {
        patch[fromPassword ? "moloni_pending_environment" : "moloni_environment"] = environment;
    }

    // Where the callback puts the merchant down. A slug through the fixed map in
    // oauth-return, never a path from the request.
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
