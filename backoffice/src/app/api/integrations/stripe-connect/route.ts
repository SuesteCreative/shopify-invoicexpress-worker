import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/account";
import { getStripeEnvOptional } from "@/lib/stripe";
import { isStripeConnectEnabled, resolveTargetUser } from "@/lib/stripe-connect";

export const runtime = "edge";

/**
 * Stripe Connect connections (`source_kind = 'stripe_connect'`).
 *
 * A sibling of `/api/integrations/stripe-source`, NOT a replacement for it. The
 * merchants on that route pasted a restricted key and their connections keep
 * working exactly as they do today; this one holds no key of theirs at all, only
 * the `acct_…` they authorised us against.
 *
 * GET    — connection state for the wizard.
 * DELETE — revoke at Stripe and drop the connection's credentials.
 */

export async function GET(request: NextRequest) {
    if (!isStripeConnectEnabled()) return NextResponse.json({ error: "Disabled" }, { status: 404 });

    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    const row: any = await db
        .prepare(`SELECT id, status, source_config_json, destination_config_json, destination_kind, created_at, updated_at
                    FROM connections WHERE user_id = ? AND source_kind = 'stripe_connect' LIMIT 1`)
        .bind(authResult.targetUserId)
        .first();

    if (!row) return NextResponse.json({ connection: null });

    const src = row.source_config_json ? JSON.parse(row.source_config_json) : {};
    const dest = row.destination_config_json ? JSON.parse(row.destination_config_json) : {};

    // Never the tokens themselves, only whether they exist. The Moloni access and
    // refresh tokens are as sensitive as the password they replaced.
    return NextResponse.json({
        connection: {
            id: row.id,
            status: row.status,
            destination_kind: row.destination_kind,
            created_at: row.created_at,
            updated_at: row.updated_at,
            stripe: {
                connected: !!src.stripe_account_id,
                stripe_account_id: src.stripe_account_id ?? null,
                scope: src.scope ?? null,
                connected_at: src.connected_at ?? null,
                deauthorized_at: src.deauthorized_at ?? null,
            },
            moloni: {
                authorized: !!dest.moloni_refresh_token,
                has_app_credentials: !!(dest.moloni_client_id && dest.moloni_client_secret),
                refresh_expires_at: dest.moloni_refresh_expires_at ?? null,
                company_name: dest.moloni_company_name ?? null,
                document_set_name: dest.moloni_document_set_name ?? null,
                error: dest.moloni_oauth_error ?? null,
            },
        },
    });
}

export async function DELETE(request: NextRequest) {
    if (!isStripeConnectEnabled()) return NextResponse.json({ error: "Disabled" }, { status: 404 });

    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    const row: any = await db
        .prepare("SELECT id, source_config_json FROM connections WHERE user_id = ? AND source_kind = 'stripe_connect' LIMIT 1")
        .bind(authResult.targetUserId)
        .first();
    if (!row) return NextResponse.json({ ok: true, already_gone: true });

    const cfg = row.source_config_json ? JSON.parse(row.source_config_json) : {};
    const clientId = getStripeEnvOptional("STRIPE_CONNECT_CLIENT_ID");
    const platformKey = getStripeEnvOptional("STRIPE_SECRET_KEY");

    // Tell Stripe first. If we only dropped our row, the merchant would still see
    // Rioko listed as an authorised application in their dashboard forever.
    let revoked = false;
    if (cfg.stripe_account_id && clientId && platformKey) {
        try {
            const body = new URLSearchParams({ client_id: clientId, stripe_user_id: cfg.stripe_account_id });
            const res = await fetch("https://connect.stripe.com/oauth/deauthorize", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${platformKey}`,
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: body.toString(),
            });
            // Stripe answers 400 when the account is already disconnected, which is
            // the outcome we wanted anyway.
            revoked = res.ok || res.status === 400;
        } catch {
            revoked = false;
        }
    }

    const now = new Date().toISOString();
    await db.prepare(
        `UPDATE connections
            SET status = 'paused', updated_at = ?,
                source_config_json = json_patch(COALESCE(source_config_json, '{}'), ?)
          WHERE id = ?`
    ).bind(now, JSON.stringify({ stripe_account_id: null, deauthorized_at: now }), row.id).run();

    return NextResponse.json({ ok: true, revoked_at_stripe: revoked });
}
