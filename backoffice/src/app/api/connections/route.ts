import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getImpersonationId } from "@/lib/admin";

export const runtime = "edge";

// Phase 2: internal-only CRUD for `connections`. Not wired into the UI yet —
// Phase 3+ will start writing to this table alongside the legacy `integrations`
// row. Until then, this endpoint exists for migration testing and superadmin
// inspection only.

type SourceKind = "shopify" | "stripe";
type DestinationKind = "invoicexpress" | "moloni";

const SOURCE_KINDS: SourceKind[] = ["shopify", "stripe"];
const DESTINATION_KINDS: DestinationKind[] = ["invoicexpress", "moloni"];

async function resolveTargetUser(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return { error: "Unauthorized", status: 401 as const };

    let targetUserId = userId;
    if (await isAdmin(userId)) {
        const impersonationId = await getImpersonationId(request);
        if (impersonationId) targetUserId = impersonationId;
    }
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

        if (!body.source_kind || !SOURCE_KINDS.includes(body.source_kind as SourceKind)) {
            return NextResponse.json({ error: `source_kind must be one of: ${SOURCE_KINDS.join(", ")}` }, { status: 400 });
        }
        if (!body.destination_kind || !DESTINATION_KINDS.includes(body.destination_kind as DestinationKind)) {
            return NextResponse.json({ error: `destination_kind must be one of: ${DESTINATION_KINDS.join(", ")}` }, { status: 400 });
        }

        const allowedStatuses = ["draft", "active", "paused", "error"];
        const status = body.status && allowedStatuses.includes(body.status) ? body.status : "draft";

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
