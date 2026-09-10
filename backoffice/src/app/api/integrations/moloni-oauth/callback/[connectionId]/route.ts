import { getRequestContext } from "@cloudflare/next-on-pages";
import { NextRequest, NextResponse } from "next/server";
import { RIOKO_CONFIG } from "@/lib/config";
import { isStripeConnectEnabled, resolveTargetUser, moloniRedirectUri } from "@/lib/stripe-connect";
import { resolveReturnPath, RETURN_SLUG_WIZARD } from "@/lib/oauth-return";

export const runtime = "edge";

const REFRESH_TOKEN_TTL_DAYS = 14;

/**
 * Moloni sends the merchant back here with a one-time code.
 *
 * The connection id is in the path because it is also in the redirect URI the
 * merchant registered in their Moloni app — Moloni allows exactly one, so it is
 * per connection by construction, and this route never has to guess which
 * connection a code belongs to.
 *
 * What lands in the database is a pair of tokens with a fortnight's life, not a
 * username and password with none. That is the whole point of the exercise.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ connectionId: string }> }) {
    if (!isStripeConnectEnabled()) return NextResponse.json({ error: "Disabled" }, { status: 404 });

    // Whether this merchant is walking the dashboard wizard or the guided
    // onboarding page is written on the connection row by the Stripe step, so it
    // is known only once the row is read. Request-local: a module variable would
    // leak one merchant's page into the next request's redirect.
    let returnPath = resolveReturnPath(RETURN_SLUG_WIZARD, "pt");

    const backToWizard = (status: string, detail?: string) => {
        const url = new URL(`${RIOKO_CONFIG.appUrl}${returnPath}`);
        url.searchParams.set("moloni", status);
        if (detail) url.searchParams.set("detail", detail.slice(0, 200));
        return NextResponse.redirect(url.toString(), 302);
    };

    const { connectionId } = await context.params;
    const params = request.nextUrl.searchParams;
    const code = params.get("code");
    const error = params.get("error");

    if (error) return backToWizard("denied", params.get("error_description") ?? error);
    if (!code) return backToWizard("error", "O Moloni não devolveu o código de autorização");

    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return backToWizard("error", "A sessão expirou. Entre outra vez e repita.");

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return backToWizard("error", "Database binding missing");

    // Scoped by user as well as by id: the id travels in a URL the merchant
    // pasted into a third-party console, so it must not be enough on its own to
    // write to somebody else's connection.
    const row: any = await db
        .prepare(`SELECT id, destination_config_json, source_config_json FROM connections
                   WHERE id = ? AND user_id = ? AND source_kind = 'stripe_connect' LIMIT 1`)
        .bind(connectionId, authResult.targetUserId)
        .first();
    if (!row) return backToWizard("error", "Ligação não encontrada.");

    const startedOn = row.source_config_json ? JSON.parse(row.source_config_json) : {};
    returnPath = resolveReturnPath(startedOn.return_slug, startedOn.return_locale);

    const cfg = row.destination_config_json ? JSON.parse(row.destination_config_json) : {};
    const clientId = cfg.moloni_client_id;
    const clientSecret = cfg.moloni_client_secret;
    if (!clientId || !clientSecret) {
        return backToWizard("error", "Faltam as credenciais da aplicação Moloni. Recomece o passo do Moloni.");
    }

    const baseUrl = cfg.moloni_environment === "sandbox"
        ? "https://apidemo.moloni.pt/v1"
        : "https://api.moloni.pt/v1";

    const grantUrl = new URL(`${baseUrl}/grant/`);
    grantUrl.searchParams.set("grant_type", "authorization_code");
    grantUrl.searchParams.set("client_id", clientId);
    grantUrl.searchParams.set("client_secret", clientSecret);
    grantUrl.searchParams.set("redirect_uri", moloniRedirectUri(row.id));
    grantUrl.searchParams.set("code", code);

    let body: any;
    try {
        const res = await fetch(grantUrl.toString(), {
            method: "POST",
            headers: { "Accept": "application/json" },
        });
        const text = await res.text();
        try { body = JSON.parse(text); } catch { body = null; }
        if (!res.ok) {
            return backToWizard("error", String(body?.error_description ?? body?.error ?? `Moloni ${res.status}`));
        }
    } catch (e: any) {
        return backToWizard("error", `Não foi possível falar com o Moloni: ${e?.message ?? e}`);
    }

    const accessToken = body?.access_token;
    const refreshToken = body?.refresh_token;
    if (!accessToken || !refreshToken) {
        // An access token with no refresh token would work for one hour and then
        // strand the connection with no way back.
        return backToWizard("error", "O Moloni não devolveu um refresh token.");
    }

    const now = Date.now();
    const expiresIn = Number(body?.expires_in ?? 3600);
    await db.prepare(
        `UPDATE connections
            SET destination_config_json = json_patch(COALESCE(destination_config_json, '{}'), ?),
                oauth_state = NULL, oauth_state_expires_at = NULL,
                last_token_refresh_at = ?, updated_at = ?
          WHERE id = ?`
    ).bind(
        JSON.stringify({
            moloni_auth_mode: "oauth",
            moloni_access_token: accessToken,
            moloni_refresh_token: refreshToken,
            moloni_token_expires_at: new Date(now + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000).toISOString(),
            moloni_refresh_expires_at: new Date(now + REFRESH_TOKEN_TTL_DAYS * 86_400_000).toISOString(),
            moloni_oauth_error: null,
        }),
        new Date(now).toISOString(), new Date(now).toISOString(), row.id,
    ).run();

    return backToWizard("connected");
}
