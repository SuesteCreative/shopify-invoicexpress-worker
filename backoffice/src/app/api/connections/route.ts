import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/account";
import {
    SOURCE_KINDS, DESTINATION_KINDS, CONNECTION_STATUSES,
    isSourceKind, isDestinationKind,
} from "@/lib/connection-kinds";
import { getStripeEnvOptional } from "@/lib/stripe";

export const runtime = "edge";

// Internal CRUD for `connections`. GET is consumed by the integrations page;
// POST is superadmin/migration tooling.

async function resolveTargetUser(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return { error: "Unauthorized", status: 401 as const };

    let targetUserId = await resolveAccountUser(request, userId);
    return { userId, targetUserId };
}

export async function GET(request: NextRequest) {
    try {
        const auth = await resolveTargetUser(request);
        if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

        const { env } = getRequestContext();
        const db = (env as any).DB;
        if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

        const rows = await db
            .prepare("SELECT * FROM connections WHERE user_id = ? ORDER BY created_at ASC")
            .bind(auth.targetUserId)
            .all();

        return NextResponse.json({ connections: rows.results ?? [] });
    } catch (error: any) {
        console.error("[connections] GET error:", error);
        return NextResponse.json({ error: `Internal Server Error: ${error.message}` }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    try {
        const authResult = await resolveTargetUser(request);
        if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

        const body = await request.json() as {
            id?: string;
            source_kind?: string;
            destination_kind?: string;
            source_config?: unknown;
            destination_config?: unknown;
            behavior?: unknown;
            status?: string;
        };

        if (!isSourceKind(body.source_kind)) {
            return NextResponse.json({ error: `source_kind must be one of: ${SOURCE_KINDS.join(", ")}` }, { status: 400 });
        }
        if (!isDestinationKind(body.destination_kind)) {
            return NextResponse.json({ error: `destination_kind must be one of: ${DESTINATION_KINDS.join(", ")}` }, { status: 400 });
        }

        const status = body.status && (CONNECTION_STATUSES as readonly string[]).includes(body.status)
            ? body.status
            : "draft";

        const { env } = getRequestContext();
        const db = (env as any).DB;
        if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

        const id = body.id ?? crypto.randomUUID();
        const now = new Date().toISOString();

        await db.prepare(
            `INSERT INTO connections
              (id, user_id, source_kind, destination_kind, source_config_json, destination_config_json, behavior_json, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id, source_kind, destination_kind) DO UPDATE SET
               source_config_json = excluded.source_config_json,
               destination_config_json = excluded.destination_config_json,
               behavior_json = excluded.behavior_json,
               status = excluded.status,
               updated_at = excluded.updated_at`
        ).bind(
            id,
            authResult.targetUserId,
            body.source_kind,
            body.destination_kind,
            body.source_config != null ? JSON.stringify(body.source_config) : null,
            body.destination_config != null ? JSON.stringify(body.destination_config) : null,
            body.behavior != null ? JSON.stringify(body.behavior) : null,
            status,
            now,
            now,
        ).run();

        const row: any = await db.prepare(
            "SELECT * FROM connections WHERE user_id = ? AND source_kind = ? AND destination_kind = ?"
        ).bind(authResult.targetUserId, body.source_kind, body.destination_kind).first();

        return NextResponse.json({ connection: row });
    } catch (error: any) {
        console.error("[connections] POST error:", error);
        return NextResponse.json({ error: `Internal Server Error: ${error.message}` }, { status: 500 });
    }
}

/**
 * Delete one connection.
 *
 * Deliberately narrow about what "delete" means: it removes the CONNECTION —
 * the credentials, the settings, the authorisation — and nothing else. The
 * documents already issued, and the `processed_orders` rows that record them,
 * stay exactly where they are. Those are the merchant's fiscal history and the
 * reason a re-setup does not re-invoice a year of sales; deleting them to make
 * the row disappear cleanly would be the single most destructive thing this
 * codebase could do.
 *
 * Requires `confirm` to equal `<source_kind>:<destination_kind>`. The typed
 * confirmation in the UI is the human guard; this is the one that stops a stray
 * fetch, a replayed request, or an agent from deleting a live integration.
 */
export async function DELETE(request: NextRequest) {
    try {
        const authResult = await resolveTargetUser(request);
        if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

        const url = new URL(request.url);
        const sourceKind = url.searchParams.get("source_kind") ?? "";
        const destinationKind = url.searchParams.get("destination_kind") ?? "";
        const confirm = url.searchParams.get("confirm") ?? "";

        if (!isSourceKind(sourceKind) || !isDestinationKind(destinationKind)) {
            return NextResponse.json({ error: "Unknown connection kind" }, { status: 400 });
        }
        if (confirm !== `${sourceKind}:${destinationKind}`) {
            return NextResponse.json({ error: "Confirmation does not match this connection" }, { status: 400 });
        }

        const { env } = getRequestContext();
        const db = (env as any).DB;
        if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

        const row: any = await db.prepare(
            `SELECT id, source_config_json FROM connections
              WHERE user_id = ? AND source_kind = ? AND destination_kind = ? LIMIT 1`
        ).bind(authResult.targetUserId, sourceKind, destinationKind).first();

        if (!row) return NextResponse.json({ ok: true, already_gone: true });

        // Tell Stripe before we forget the account id. Otherwise the merchant is
        // left with Rioko listed as an authorised application in their own
        // dashboard, with nothing on our side able to revoke it.
        let revokedAtStripe: boolean | null = null;
        if (sourceKind === "stripe_connect") {
            const cfg = row.source_config_json ? JSON.parse(row.source_config_json) : {};
            const clientId = getStripeEnvOptional("STRIPE_CONNECT_CLIENT_ID");
            const platformKey = getStripeEnvOptional("STRIPE_SECRET_KEY");
            if (cfg.stripe_account_id && clientId && platformKey) {
                try {
                    const res = await fetch("https://connect.stripe.com/oauth/deauthorize", {
                        method: "POST",
                        headers: {
                            Authorization: `Bearer ${platformKey}`,
                            "Content-Type": "application/x-www-form-urlencoded",
                        },
                        body: new URLSearchParams({ client_id: clientId, stripe_user_id: cfg.stripe_account_id }).toString(),
                    });
                    // 400 is Stripe saying it was already disconnected, which is
                    // the state we wanted.
                    revokedAtStripe = res.ok || res.status === 400;
                } catch {
                    revokedAtStripe = false;
                }
            }
        }

        // Routing rules and product mappings belong to the connection, not to the
        // history, so they go with it. Leaving them behind would silently apply a
        // deleted connection's rules to a new one set up under the same pair.
        for (const sql of [
            "DELETE FROM tag_routing_rules WHERE user_id = ? AND source_kind = ? AND destination_kind = ?",
            "DELETE FROM product_mappings WHERE user_id = ? AND source_kind = ? AND destination_kind = ?",
        ]) {
            // Best-effort: a missing side table must not leave the connection
            // itself undeletable.
            try {
                await db.prepare(sql).bind(authResult.targetUserId, sourceKind, destinationKind).run();
            } catch { /* nothing to clean up */ }
        }

        await db.prepare("DELETE FROM connections WHERE id = ?").bind(row.id).run();

        return NextResponse.json({ ok: true, revoked_at_stripe: revokedAtStripe });
    } catch (e: any) {
        return NextResponse.json({ error: e?.message ?? "Delete failed" }, { status: 500 });
    }
}
