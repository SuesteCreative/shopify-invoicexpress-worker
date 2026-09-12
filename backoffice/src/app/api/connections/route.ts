import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/account";
import { missingDestinationCredentials } from "@/lib/destination-credentials";
import { CONNECTION_PUBLIC_SELECT } from "@/lib/redact";
import {
    SOURCE_KINDS, DESTINATION_KINDS, CONNECTION_STATUSES,
    isSourceKind, isDestinationKind,
} from "@/lib/connection-kinds";
import { deleteConnection } from "@/lib/connection-lifecycle";
import { grantReferralGrace } from "@/lib/referral-grace";

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

        // Never `SELECT *`: the config blobs on this table are credentials, and
        // this response goes to a browser. CONNECTION_PUBLIC_SELECT is the
        // allowlist — see lib/redact.ts.
        const rows = await db
            .prepare(`SELECT ${CONNECTION_PUBLIC_SELECT} FROM connections WHERE user_id = ? ORDER BY created_at ASC`)
            .bind(auth.targetUserId)
            .all();

        // `status` says what the merchant asked for; `destination_ready` says
        // whether it can actually issue. An active connection whose destination
        // has no credentials is the state that let three accounts sit quietly
        // uninvoiced, and every caller of this endpoint was showing it as
        // "Autorizado" because the row said active.
        const connections = await Promise.all(((rows.results ?? []) as any[]).map(async (c) => ({
            ...c,
            destination_ready: !(await missingDestinationCredentials(
                db, auth.targetUserId!, String(c.source_kind), String(c.destination_kind),
            )),
        })));

        return NextResponse.json({ connections });
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

        // A referred account's free month is keyed to a connection (0044) and at
        // claim time there was none. One exists now, so put it here rather than
        // leave the gate refusing the first order of a merchant who was promised
        // thirty free days. A no-op for everyone who was never referred.
        await grantReferralGrace(db, authResult.targetUserId).catch(() => { /* never block a save */ });

        const row: any = await db.prepare(
            `SELECT ${CONNECTION_PUBLIC_SELECT} FROM connections
              WHERE user_id = ? AND source_kind = ? AND destination_kind = ?`
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

        // The cascade and the Stripe deauthorisation live in lib, because the
        // admin console does the same thing to somebody else's account and two
        // copies of a cascade is how one of them ends up forgetting a table.
        const result = await deleteConnection(db, authResult.targetUserId, sourceKind, destinationKind);
        return NextResponse.json(result);
    } catch (e: any) {
        return NextResponse.json({ error: e?.message ?? "Delete failed" }, { status: 500 });
    }
}
