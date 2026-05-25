import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getImpersonationId } from "@/lib/admin";
import { RIOKO_CONFIG } from "@/lib/config";

export const runtime = "edge";

const WORKER_BASE = RIOKO_CONFIG.workerUrl.replace(/\/$/, "");

/**
 * EuPago source connection management.
 *
 * Stores the merchant's HMAC secret (shared with EuPago to verify webhook
 * signatures) in `connections.source_config_json`. The webhook URL the merchant
 * configures in the EuPago backoffice is:
 *     POST https://<worker-host>/webhooks/eupago/<user_id>
 *
 * Destination (IX, Moloni, Vendus) is chosen via `destination_kind` on the same
 * row. Defaults to "invoicexpress" if not provided.
 */
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

function redact(cfg: Record<string, unknown>) {
    return {
        has_hmac_secret: !!cfg.hmac_secret,
        api_key_masked: cfg.api_key ? maskKey(String(cfg.api_key)) : null,
        encrypted: cfg.encrypted === true,
    };
}

function maskKey(s: string): string {
    if (s.length <= 8) return "•".repeat(s.length);
    return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

export async function GET(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    const row: any = await db.prepare(
        `SELECT id, status, source_config_json, destination_kind, created_at, updated_at
         FROM connections WHERE user_id = ? AND source_kind = 'eupago' LIMIT 1`
    ).bind(authResult.targetUserId).first();

    if (!row) return NextResponse.json({ connection: null });

    const cfg = row.source_config_json ? JSON.parse(row.source_config_json) : {};
    return NextResponse.json({
        connection: {
            id: row.id,
            status: row.status,
            destination_kind: row.destination_kind ?? "invoicexpress",
            source_config: redact(cfg),
            created_at: row.created_at,
            updated_at: row.updated_at,
            webhook_url: `${WORKER_BASE}/webhooks/eupago/${authResult.targetUserId}`,
        },
    });
}

export async function POST(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const body = await request.json() as {
        hmac_secret?: string;
        api_key?: string;
        encrypted?: boolean;
        destination_kind?: "invoicexpress" | "moloni" | "vendus";
        status?: "draft" | "active" | "paused" | "error";
    };

    const destinationKind = ["invoicexpress", "moloni", "vendus"].includes(body.destination_kind || "")
        ? body.destination_kind!
        : "invoicexpress";

    const status = ["draft", "active", "paused", "error"].includes(body.status || "") ? body.status! : "draft";

    if (status === "active" && (!body.hmac_secret || body.hmac_secret.length < 16)) {
        return NextResponse.json({ error: "hmac_secret is required for active status (min 16 chars)" }, { status: 400 });
    }

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    // If hmac_secret is empty in the body, preserve the existing one (allows
    // editing destination_kind/status without re-pasting the secret).
    const existing: any = await db.prepare(
        `SELECT source_config_json FROM connections
         WHERE user_id = ? AND source_kind = 'eupago' AND destination_kind = ? LIMIT 1`
    ).bind(authResult.targetUserId, destinationKind).first();
    const previousCfg = existing?.source_config_json ? JSON.parse(existing.source_config_json) : {};

    const sourceCfg: Record<string, any> = {
        hmac_secret: body.hmac_secret || previousCfg.hmac_secret,
        encrypted: body.encrypted === true,
    };
    if (body.api_key) sourceCfg.api_key = body.api_key;
    else if (previousCfg.api_key) sourceCfg.api_key = previousCfg.api_key;

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.prepare(
        `INSERT INTO connections
          (id, user_id, source_kind, destination_kind, source_config_json, status, created_at, updated_at)
         VALUES (?, ?, 'eupago', ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, source_kind, destination_kind) DO UPDATE SET
           source_config_json = excluded.source_config_json,
           status = excluded.status,
           updated_at = excluded.updated_at`
    ).bind(id, authResult.targetUserId, destinationKind, JSON.stringify(sourceCfg), status, now, now).run();

    return NextResponse.json({
        ok: true,
        webhook_url: `${WORKER_BASE}/webhooks/eupago/${authResult.targetUserId}`,
    });
}

export async function DELETE(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const destinationKind = new URL(request.url).searchParams.get("destination_kind") ?? "invoicexpress";

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    await db.prepare(
        `DELETE FROM connections WHERE user_id = ? AND source_kind = 'eupago' AND destination_kind = ?`
    ).bind(authResult.targetUserId, destinationKind).run();

    return NextResponse.json({ ok: true });
}
