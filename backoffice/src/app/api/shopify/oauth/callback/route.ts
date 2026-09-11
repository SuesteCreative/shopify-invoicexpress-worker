import { getRequestContext } from "@cloudflare/next-on-pages";
import { NextRequest, NextResponse } from "next/server";
import { RIOKO_CONFIG } from "@/lib/config";
import { isValidOAuthState } from "@/lib/oauth-state";
import { resolveReturnPath, RETURN_SLUG_HELPER_SHOPIFY } from "@/lib/oauth-return";
import {
    cleanShopDomain, exchangeCode, installWebhooks, verifyCallbackHmac,
    SHOPIFY_API_VERSION, SHOPIFY_WEBHOOKS,
} from "@/lib/shopify-oauth";

export const runtime = "edge";

/**
 * Step 2 of "Método 2": Shopify sends the merchant back here with a code.
 *
 * Public by necessity. Whoever presses Install is signed in to the Shopify
 * admin, which is not the same person or even the same browser as the operator
 * who started the flow, so there is no Clerk session to read. The account is
 * identified by the one-shot state instead, and the request is authenticated by
 * the HMAC Shopify computes over the query string with the app's client secret:
 * a code arriving without both is worth nothing.
 */
export async function GET(request: NextRequest) {
    const returnPath = resolveReturnPath(RETURN_SLUG_HELPER_SHOPIFY, "pt");

    /** Back to the helper with something it can render, never a bare JSON error. */
    const back = (status: string, detail?: string) => {
        const url = new URL(`${RIOKO_CONFIG.appUrl}${returnPath}`);
        url.searchParams.set("shopify", status);
        if (detail) url.searchParams.set("detail", detail.slice(0, 200));
        return NextResponse.redirect(url.toString(), 302);
    };

    const params = request.nextUrl.searchParams;
    const error = params.get("error");
    const code = params.get("code");
    const state = params.get("state");
    const shopParam = cleanShopDomain(params.get("shop") ?? "");

    if (error) return back("denied", params.get("error_description") ?? error);
    if (!code || !state) return back("error", "A Shopify não devolveu código de autorização.");

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return back("error", "Database binding missing");

    // By state alone, not by user: there is no session here. The state is a
    // v4 UUID, so it names exactly one row across the whole table.
    const row: any = await db
        .prepare(`SELECT user_id, shopify_domain, shopify_client_id, shopify_client_secret,
                         shopify_oauth_state, shopify_oauth_state_expires_at
                    FROM integrations WHERE shopify_oauth_state = ? LIMIT 1`)
        .bind(state)
        .first();

    if (!row) return back("error", "Pedido desconhecido. Recomece o Método 2 no helper.");
    if (!isValidOAuthState(row.shopify_oauth_state, row.shopify_oauth_state_expires_at, state)) {
        return back("error", "Pedido expirado (15 minutos). Recomece o Método 2 no helper.");
    }
    if (!row.shopify_client_id || !row.shopify_client_secret) {
        return back("error", "Faltam as credenciais da app. Recomece o Método 2 no helper.");
    }
    if (!await verifyCallbackHmac(params, row.shopify_client_secret)) {
        return back("error", "Assinatura inválida no regresso da Shopify.");
    }
    // The consent could have been given on a different store than the one this
    // row was started for, which would attach the wrong shop's token.
    if (shopParam && row.shopify_domain && shopParam.toLowerCase() !== String(row.shopify_domain).toLowerCase()) {
        return back("error", `A autorização veio de ${shopParam}, não de ${row.shopify_domain}.`);
    }

    const exchange = await exchangeCode(
        row.shopify_domain, row.shopify_client_id, row.shopify_client_secret, code,
    );
    if (!exchange.ok) return back("error", exchange.detail);

    /**
     * The client secret is written into `shopify_webhook_secret` on purpose.
     *
     * That column means one thing to the worker: the secret Shopify signs this
     * store's webhooks with. For a store on the manual flow that is the store's
     * own signing secret; for the subscriptions created below, which belong to
     * the app, it is the app's client secret. Storing it here is what lets the
     * worker verify them without a single line changing.
     *
     * ponytail: yes, the same value now sits in two columns. Deliberate — the
     * alternative is a candidate-secret loop in the worker's hot path plus a
     * deploy, to save one duplicated string.
     */
    const now = new Date().toISOString();
    await db.prepare(
        `UPDATE integrations
            SET shopify_token = ?,
                shopify_webhook_secret = ?,
                shopify_api_version = ?,
                shopify_authorized = 1,
                shopify_error = NULL,
                shopify_oauth_state = NULL,
                shopify_oauth_state_expires_at = NULL,
                updated_at = ?
          WHERE user_id = ?`
    ).bind(
        exchange.accessToken, row.shopify_client_secret, SHOPIFY_API_VERSION, now, row.user_id,
    ).run();

    const install = await installWebhooks(row.shopify_domain, exchange.accessToken, SHOPIFY_API_VERSION);
    const live = install.created.length + install.existing.length;

    if (live === SHOPIFY_WEBHOOKS.length) {
        await db.prepare(
            `UPDATE integrations SET webhooks_active = 1, updated_at = ? WHERE user_id = ?`
        ).bind(now, row.user_id).run();
        return back("connected", `${install.created.length} criados, ${install.existing.length} já existiam`);
    }

    // Token is stored and valid; only some subscriptions are missing. Running
    // Método 2 again picks up exactly the ones that failed.
    return back(
        "partial",
        `${live}/${SHOPIFY_WEBHOOKS.length} webhooks. Falhou: ${install.failed.map(f => `${f.topic} (${f.detail})`).join("; ")}`,
    );
}
