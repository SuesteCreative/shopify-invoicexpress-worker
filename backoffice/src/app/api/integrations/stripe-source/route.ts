import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getImpersonationId } from "@/lib/admin";

export const runtime = "edge";

/**
 * Phase 3 — Stripe-as-a-source connection management. Hidden behind feature flag:
 *   NEXT_PUBLIC_STRIPE_SOURCE_ENABLED=1 in the backoffice env
 * The worker has its own gate via STRIPE_SOURCE_ENABLED.
 *
 * Writes a `connections` row with source_kind='stripe' (drafts a connection
 * pointing at IX as destination by default). Does NOT touch the legacy
 * `integrations` row — Stripe-source data lives only in `connections`.
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

function isEnabled() {
    return process.env.NEXT_PUBLIC_STRIPE_SOURCE_ENABLED === "1"
        || process.env.STRIPE_SOURCE_ENABLED === "1";
}

export async function GET(request: NextRequest) {
    if (!isEnabled()) return NextResponse.json({ error: "Disabled" }, { status: 404 });

    const auth = await resolveTargetUser(request);
    if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    const row: any = await db
        .prepare("SELECT id, status, source_config_json, destination_kind, created_at, updated_at FROM connections WHERE user_id = ? AND source_kind = 'stripe' LIMIT 1")
        .bind(auth.targetUserId)
        .first();

    if (!row) return NextResponse.json({ connection: null });

    // Redact webhook_secret + restricted key from response — only return non-secret fields.
    const cfg = row.source_config_json ? JSON.parse(row.source_config_json) : {};
    const safeCfg = {
        stripe_account_id: cfg.stripe_account_id ?? null,
        has_webhook_secret: !!cfg.webhook_secret,
        has_restricted_key: !!cfg.restricted_key,
    };
    return NextResponse.json({
        connection: {
            id: row.id, status: row.status, destination_kind: row.destination_kind,
            source_config: safeCfg, created_at: row.created_at, updated_at: row.updated_at,
        }
    });
}

export async function POST(request: NextRequest) {
    if (!isEnabled()) return NextResponse.json({ error: "Disabled" }, { status: 404 });

    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const body = await request.json() as {
        stripe_account_id?: string;
        webhook_secret?: string;
        restricted_key?: string;
        destination_kind?: string;
        status?: string;
    };

    if (!body.stripe_account_id || typeof body.stripe_account_id !== "string") {
        return NextResponse.json({ error: "Missing stripe_account_id" }, { status: 400 });
    }
    const destinationKind = body.destination_kind === "moloni" ? "moloni" : "invoicexpress";
    const status = ["draft", "active", "paused", "error"].includes(body.status || "") ? body.status : "draft";

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    const sourceConfig: Record<string, any> = { stripe_account_id: body.stripe_account_id };
    if (body.webhook_secret) sourceConfig.webhook_secret = body.webhook_secret;
    if (body.restricted_key) sourceConfig.restricted_key = body.restricted_key;

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.prepare(
        `INSERT INTO connections
          (id, user_id, source_kind, destination_kind, source_config_json, status, created_at, updated_at)
         VALUES (?, ?, 'stripe', ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, source_kind, destination_kind) DO UPDATE SET
           source_config_json = excluded.source_config_json,
           status = excluded.status,
           updated_at = excluded.updated_at`
    ).bind(id, authResult.targetUserId, destinationKind, JSON.stringify(sourceConfig), status, now, now).run();

    return NextResponse.json({ ok: true });
}
