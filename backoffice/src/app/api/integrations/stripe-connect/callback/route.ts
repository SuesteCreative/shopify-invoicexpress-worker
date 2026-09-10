import { getRequestContext } from "@cloudflare/next-on-pages";
import { NextRequest, NextResponse } from "next/server";
import { RIOKO_CONFIG } from "@/lib/config";
import { getStripeEnvOptional } from "@/lib/stripe";
import { isValidOAuthState } from "@/lib/oauth-state";
import { isStripeConnectEnabled, resolveTargetUser, stripeConnectRedirectUri, stripeConnectCredentials } from "@/lib/stripe-connect";

export const runtime = "edge";

/**
 * The wizard this connection belongs to.
 *
 * Was hardcoded to the Moloni page, with the locale in it too, so a merchant
 * connecting Stripe to InvoiceXpress landed on someone else's wizard. The
 * destination is on the row the callback already reads; before that row is in
 * hand, Moloni is the older and far commoner pair.
 *
 * Not module state: a Worker isolate serves many requests, and one merchant's
 * destination must never decide another's redirect.
 */
function wizardPath(destination?: string | null) {
    return destination === "invoicexpress"
        ? "/pt/integrations/stripe-connect-ix"
        : "/pt/integrations/stripe-connect-moloni";
}

/** Back to the wizard with a message it can render, never a bare JSON error. */
function backToWizard(status: string, detail?: string, destination?: string | null) {
    const url = new URL(`${RIOKO_CONFIG.appUrl}${wizardPath(destination)}`);
    url.searchParams.set("stripe", status);
    if (detail) url.searchParams.set("detail", detail.slice(0, 200));
    return NextResponse.redirect(url.toString(), 302);
}

/**
 * Step 2: Stripe sends the merchant back here with a one-time code.
 *
 * What we store is the account id. Not a key, not a token we have to keep alive —
 * from here on their account is read with Rioko's own platform key and a
 * `Stripe-Account` header.
 */
export async function GET(request: NextRequest) {
    if (!isStripeConnectEnabled()) return NextResponse.json({ error: "Disabled" }, { status: 404 });

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
        .prepare(`SELECT id, oauth_state, oauth_state_expires_at, source_config_json, destination_kind
                    FROM connections WHERE user_id = ? AND source_kind = 'stripe_connect' LIMIT 1`)
        .bind(authResult.targetUserId)
        .first();

    if (!row) return backToWizard("error", "Ligação não encontrada. Recomece o passo do Stripe.");

    // CSRF. Without this check anyone could hand a logged-in merchant a link that
    // attaches THEIR Stripe account to the merchant's Rioko connection.
    if (!isValidOAuthState(row.oauth_state, row.oauth_state_expires_at, state)) {
        return backToWizard("error", "Pedido inválido ou expirado. Recomece o passo do Stripe.", row.destination_kind);
    }

    // Which mode the merchant left in, recorded by /start. A test client_id
    // exchanged with the live secret key is rejected outright.
    let startedConfig: Record<string, any> = {};
    try { startedConfig = row.source_config_json ? JSON.parse(row.source_config_json) : {}; } catch { startedConfig = {}; }
    const mode = startedConfig.livemode === false ? "test" as const : "live" as const;
    const { secretKey: platformKey } = stripeConnectCredentials(mode);
    if (!platformKey) return backToWizard("error", `STRIPE_SECRET_KEY${mode === "test" ? "_TEST" : ""} not configured`, row.destination_kind);

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
            return backToWizard("error", String(tokenBody?.error_description ?? tokenBody?.error ?? `Stripe ${res.status}`), row.destination_kind);
        }
    } catch (e: any) {
        return backToWizard("error", `Não foi possível falar com o Stripe: ${e?.message ?? e}`, row.destination_kind);
    }

    const stripeAccountId = tokenBody?.stripe_user_id;
    if (!stripeAccountId) return backToWizard("error", "O Stripe não devolveu a conta ligada", row.destination_kind);

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

    return backToWizard("connected", undefined, row.destination_kind);
}
