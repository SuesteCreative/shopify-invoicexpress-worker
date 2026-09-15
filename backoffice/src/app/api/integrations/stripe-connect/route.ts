import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/account";
import { getStripeEnvOptional } from "@/lib/stripe";
import { isStripeConnectEnabled, resolveTargetUser } from "@/lib/stripe-connect";
import { destinationKindOrNull } from "@/lib/connection-kinds";

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

    // `destination_kind` narrows when the caller names it. An account can run
    // `stripe_connect → invoicexpress` and `stripe_connect → moloni` at once, and
    // `LIMIT 1` with no ORDER BY showed one wizard the other's Stripe status.
    // Absent stays broad for callers that predate the parameter, but
    // oldest-first so two loads agree with each other.
    const rawDestination = new URL(request.url).searchParams.get("destination_kind");
    const destinationKind = destinationKindOrNull(rawDestination, null as any);
    if (rawDestination && !destinationKind) {
        return NextResponse.json({ error: `Unknown destination_kind ${JSON.stringify(rawDestination)}` }, { status: 400 });
    }

    const SELECT = `SELECT id, status, source_config_json, destination_config_json, destination_kind, created_at, updated_at,
                           tax_probe_at, tax_probe_verdict, runin_asked_at, runin_answer
                      FROM connections WHERE user_id = ? AND source_kind = 'stripe_connect'`;
    const row: any = destinationKind
        ? await db.prepare(`${SELECT} AND destination_kind = ? LIMIT 1`)
            .bind(authResult.targetUserId, destinationKind).first()
        : await db.prepare(`${SELECT} ORDER BY created_at ASC LIMIT 1`)
            .bind(authResult.targetUserId).first();

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
            // What Stripe says this account does about tax, and whether anyone
            // has checked a document yet. Both are read-only here: the probe
            // writes the verdict, the merchant's own answer writes the run-in.
            tax_probe: {
                verdict: row.tax_probe_verdict ?? null,
                at: row.tax_probe_at ?? null,
                tax_from_source: dest.stripe_tax_from_source === true,
            },
            run_in: {
                asked_at: row.runin_asked_at ?? null,
                answer: row.runin_answer ?? null,
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

    // Which connection is being disconnected. Without this the Connect→IX
    // wizard's "disconnect" button could pause the Connect→Moloni connection of
    // the same account instead — a live integration taken off the air by a
    // button the merchant pressed on a different page.
    const rawDestination = new URL(request.url).searchParams.get("destination_kind");
    const destinationKind = destinationKindOrNull(rawDestination, null as any);
    if (rawDestination && !destinationKind) {
        return NextResponse.json({ error: `Unknown destination_kind ${JSON.stringify(rawDestination)}` }, { status: 400 });
    }

    const SELECT_ONE = "SELECT id, source_config_json FROM connections WHERE user_id = ? AND source_kind = 'stripe_connect'";
    const row: any = destinationKind
        ? await db.prepare(`${SELECT_ONE} AND destination_kind = ? LIMIT 1`)
            .bind(authResult.targetUserId, destinationKind).first()
        : await db.prepare(`${SELECT_ONE} ORDER BY created_at ASC LIMIT 1`)
            .bind(authResult.targetUserId).first();
    if (!row) return NextResponse.json({ ok: true, already_gone: true });

    const cfg = row.source_config_json ? JSON.parse(row.source_config_json) : {};
    const clientId = getStripeEnvOptional("STRIPE_CONNECT_CLIENT_ID");
    const platformKey = getStripeEnvOptional("STRIPE_SECRET_KEY");

    // The authorisation at Stripe belongs to the ACCOUNT, not to one of our
    // connections: both `stripe_connect` rows of a merchant read the same
    // `acct_…` through the same platform key. So revoking it while another
    // connection is still using it would take that one down too, silently and
    // from Stripe's side, where nothing we own would report it.
    //
    // Revoke only when this is the last one standing.
    const others: any = await db
        .prepare(`SELECT COUNT(*) AS n FROM connections
                   WHERE user_id = ? AND source_kind = 'stripe_connect' AND id != ?
                     AND json_extract(source_config_json, '$.stripe_account_id') = ?`)
        .bind(authResult.targetUserId, row.id, cfg.stripe_account_id ?? null)
        .first();
    const lastOneStanding = Number(others?.n ?? 0) === 0;

    // Tell Stripe first. If we only dropped our row, the merchant would still see
    // Rioko listed as an authorised application in their dashboard forever.
    let revoked = false;
    if (lastOneStanding && cfg.stripe_account_id && clientId && platformKey) {
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

    return NextResponse.json({
        ok: true,
        revoked_at_stripe: revoked,
        // False when another connection of this account is still authorised on
        // the same Stripe account, so the operator can see why Stripe was not told.
        kept_stripe_authorisation: !lastOneStanding,
    });
}
