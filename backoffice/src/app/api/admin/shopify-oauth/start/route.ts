import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { newOAuthState } from "@/lib/oauth-state";
import { buildAuthorizeUrl, cleanShopDomain } from "@/lib/shopify-oauth";

export const runtime = "edge";

/**
 * Step 1 of "Método 2": store the app credentials and mint the consent URL.
 *
 * Operator-only. The merchant still creates the app in their own Dev Dashboard
 * — there is no public Marketplace app yet, and the protected customer data
 * approval lives on their app — but the client id and secret are typed into the
 * onboarding helper by whoever is running the onboarding, not into a page the
 * merchant drives.
 */
export async function POST(request: NextRequest) {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({})) as {
        user_id?: string; shop?: string; client_id?: string; client_secret?: string; force?: boolean;
    };

    const targetUserId = String(body.user_id ?? "").trim();
    const shop = cleanShopDomain(String(body.shop ?? ""));
    const clientId = String(body.client_id ?? "").trim();
    const clientSecret = String(body.client_secret ?? "").trim();

    if (!targetUserId || !shop || !clientId || !clientSecret) {
        return NextResponse.json({ error: "Faltam conta, domínio, client id ou client secret." }, { status: 400 });
    }
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) {
        return NextResponse.json({ error: `"${shop}" não é um domínio .myshopify.com.` }, { status: 400 });
    }

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    const existing: any = await db
        .prepare(`SELECT id, shopify_domain, shopify_webhook_secret, webhooks_active
                    FROM integrations WHERE user_id = ? LIMIT 1`)
        .bind(targetUserId)
        .first();

    /**
     * The guard that matters.
     *
     * A store already on the manual flow has four store-owned subscriptions that
     * this endpoint cannot see (an app only lists its own). Running Método 2
     * there would add a SECOND set, and both would deliver: documents twice over
     * and a flood of signature alerts from whichever set the stored secret does
     * not match. That is exactly what happened to Soul Krave and Estrela Jewelry
     * Studio on 2026-05-21 and went unnoticed for three months, because the
     * working set kept invoicing normally the whole time.
     *
     * So: a live-looking row is refused outright. `force` exists for a row the
     * operator has just cleared and knows is empty, never as a way past a
     * surprise.
     */
    if (!body.force && existing && (existing.webhooks_active === 1 || existing.shopify_webhook_secret)) {
        return NextResponse.json({
            error: "Esta conta já tem uma ligação Shopify a funcionar pelo método manual.",
            reason: "Ligar o Método 2 por cima criaria um segundo conjunto de webhooks: documentos a dobrar e alertas de assinatura em catadupa. "
                + "Para migrar, apagar primeiro os 4 webhooks manuais na loja e limpar a ligação.",
            shop: existing.shopify_domain ?? null,
        }, { status: 409 });
    }

    const { state, expiresAt } = newOAuthState();
    const now = new Date().toISOString();

    // Written BEFORE the merchant leaves: the state has to still be here when
    // they come back, possibly in another browser entirely, and it is the only
    // thing that will identify them.
    if (existing) {
        await db.prepare(
            `UPDATE integrations
                SET shopify_domain = ?, shopify_client_id = ?, shopify_client_secret = ?,
                    shopify_oauth_state = ?, shopify_oauth_state_expires_at = ?,
                    updated_at = CURRENT_TIMESTAMP
              WHERE user_id = ?`
        ).bind(shop, clientId, clientSecret, state, expiresAt, targetUserId).run();
    } else {
        await db.prepare(
            `INSERT INTO integrations
               (id, user_id, shopify_domain, shopify_client_id, shopify_client_secret,
                shopify_oauth_state, shopify_oauth_state_expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(crypto.randomUUID(), targetUserId, shop, clientId, clientSecret, state, expiresAt).run();
    }

    return NextResponse.json({ authorize_url: buildAuthorizeUrl(shop, clientId, state), shop });
}
