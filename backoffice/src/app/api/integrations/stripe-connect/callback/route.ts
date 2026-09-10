import { getRequestContext } from "@cloudflare/next-on-pages";
import { NextRequest, NextResponse } from "next/server";
import { RIOKO_CONFIG } from "@/lib/config";
import { getStripeEnvOptional } from "@/lib/stripe";
import { isValidOAuthState } from "@/lib/oauth-state";
import { resolveReturnPath, RETURN_SLUG_WIZARD } from "@/lib/oauth-return";
import { isStripeConnectEnabled, resolveTargetUser, stripeConnectRedirectUri } from "@/lib/stripe-connect";

export const runtime = "edge";

/**
 * Step 2: Stripe sends the merchant back here with a one-time code.
 *
 * What we store is the account id. Not a key, not a token we have to keep alive —
 * from here on their account is read with Rioko's own platform key and a
 * `Stripe-Account` header.
 */
export async function GET(request: NextRequest) {
    if (!isStripeConnectEnabled()) return NextResponse.json({ error: "Disabled" }, { status: 404 });

    // Two pages drive this flow: the dashboard wizard and the guided onboarding
    // page a client is sent a link to. Which one is written on the connection row
    // by the start route, so it is only known once the row has been read, and
    // until then the wizard is the answer. Request-local on purpose: a module
    // variable would leak one merchant's page into the next request's redirect.
    let returnPath = resolveReturnPath(RETURN_SLUG_WIZARD, "pt");

    /** Back to where they started, with a message it can render, never a bare JSON error. */
    const backToWizard = (status: string, detail?: string) => {
        const url = new URL(`${RIOKO_CONFIG.appUrl}${returnPath}`);
        url.searchParams.set("stripe", status);
        if (detail) url.searchParams.set("detail", detail.slice(0, 200));
        return NextResponse.redirect(url.toString(), 302);
    };

    const params = request.nextUrl.searchParams;
    const error = params.get("error");
    const code = params.get("code");
    const state = params.get("state");

    // The merchant pressed "cancel" on Stripe's consent screen. Not a failure.
    if (error) return backToWizard("denied", params.get("error_description") ?? error);
    if (!code || !state) return backToWizard("error", "Stripe returned no authorisation code");

    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return backToWizard("error", "A sessão expirou. Entre outra vez e repita.");

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return backToWizard("error", "Database binding missing");

    const row: any = await db
        .prepare(`SELECT id, oauth_state, oauth_state_expires_at, source_config_json
                    FROM connections WHERE user_id = ? AND source_kind = 'stripe_connect' LIMIT 1`)
        .bind(authResult.targetUserId)
        .first();

    if (!row) return backToWizard("error", "Ligação não encontrada. Recomece o passo do Stripe.");

    const startedOn = row.source_config_json ? JSON.parse(row.source_config_json) : {};
    returnPath = resolveReturnPath(startedOn.return_slug, startedOn.return_locale);

    // CSRF. Without this check anyone could hand a logged-in merchant a link that
    // attaches THEIR Stripe account to the merchant's Rioko connection.
    if (!isValidOAuthState(row.oauth_state, row.oauth_state_expires_at, state)) {
        return backToWizard("error", "Pedido inválido ou expirado. Recomece o passo do Stripe.");
    }

    const platformKey = getStripeEnvOptional("STRIPE_SECRET_KEY");
    if (!platformKey) return backToWizard("error", "STRIPE_SECRET_KEY not configured");

    let tokenBody: any;
    try {
        const res = await fetch("https://connect.stripe.com/oauth/token", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${platformKey}`,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                code,
                // Sent back for the exchange as well, or Stripe rejects the code
                // when the platform has more than one registered redirect URI.
                redirect_uri: stripeConnectRedirectUri(),
            }).toString(),
        });
        tokenBody = await res.json();
        if (!res.ok) {
            return backToWizard("error", String(tokenBody?.error_description ?? tokenBody?.error ?? `Stripe ${res.status}`));
        }
    } catch (e: any) {
        return backToWizard("error", `Não foi possível falar com o Stripe: ${e?.message ?? e}`);
    }

    const stripeAccountId = tokenBody?.stripe_user_id;
    if (!stripeAccountId) return backToWizard("error", "O Stripe não devolveu a conta ligada");

    const now = new Date().toISOString();
    // The state is cleared in the same statement that stores the account: a code
    // is single-use at Stripe, and the state must be single-use here.
    await db.prepare(
        `UPDATE connections
            SET source_config_json = json_patch(COALESCE(source_config_json, '{}'), ?),
                oauth_state = NULL, oauth_state_expires_at = NULL,
                updated_at = ?
          WHERE id = ?`
    ).bind(
        JSON.stringify({
            auth_mode: "connect",
            stripe_account_id: stripeAccountId,
            scope: tokenBody?.scope ?? "read_only",
            livemode: tokenBody?.livemode ?? null,
            connected_at: now,
            deauthorized_at: null,
        }),
        now, row.id,
    ).run();

    return backToWizard("connected");
}
