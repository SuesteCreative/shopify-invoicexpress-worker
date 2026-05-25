import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getImpersonationId } from "@/lib/admin";

export const runtime = "edge";

/**
 * Vendus destination connection management.
 *
 * Stores Vendus API key + register/series ids + environment in
 * `connections.destination_config_json`. The worker's `VendusDestination`
 * adapter reads these via `ctx.destinationConfig`.
 *
 * Stripe-source and Shopify-source (via routing-by-destination_kind) both
 * route through the adapter pipeline when destination_kind = "vendus".
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

type VendusBody = {
    source_kind?: "stripe" | "shopify";
    vendus_api_key?: string;
    vendus_register_id?: number | string;
    vendus_series_id?: number | string;
    vendus_environment?: "production" | "sandbox";
    status?: "draft" | "active" | "paused" | "error";
};

function redactConfig(cfg: Record<string, unknown>) {
    return {
        has_api_key: !!cfg.vendus_api_key,
        vendus_register_id: cfg.vendus_register_id ?? null,
        vendus_series_id: cfg.vendus_series_id ?? null,
        vendus_environment: cfg.vendus_environment ?? "production",
    };
}

export async function GET(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const sourceKind = (new URL(request.url).searchParams.get("source_kind") ?? "stripe") === "shopify" ? "shopify" : "stripe";

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    const row: any = await db
        .prepare(
            `SELECT id, status, destination_config_json, created_at, updated_at
             FROM connections WHERE user_id = ? AND source_kind = ? AND destination_kind = 'vendus' LIMIT 1`
        )
        .bind(authResult.targetUserId, sourceKind)
        .first();

    if (!row) return NextResponse.json({ connection: null });

    const cfg = row.destination_config_json ? JSON.parse(row.destination_config_json) : {};
    return NextResponse.json({
        connection: {
            id: row.id,
            status: row.status,
            source_kind: sourceKind,
            destination_config: redactConfig(cfg),
            created_at: row.created_at,
            updated_at: row.updated_at,
        },
    });
}

export async function POST(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const body = await request.json() as VendusBody;
    const sourceKind = body.source_kind === "shopify" ? "shopify" : "stripe";

    const status = ["draft", "active", "paused", "error"].includes(body.status || "") ? body.status! : "draft";

    if (status === "active" && !body.vendus_api_key) {
        return NextResponse.json({ error: "vendus_api_key required for active status" }, { status: 400 });
    }

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    // Preserve existing api_key when body omits it (so user can edit
    // register/series/status without re-pasting the secret).
    const existing: any = await db.prepare(
        `SELECT destination_config_json FROM connections
         WHERE user_id = ? AND source_kind = ? AND destination_kind = 'vendus' LIMIT 1`
    ).bind(authResult.targetUserId, sourceKind).first();
    const previousCfg = existing?.destination_config_json ? JSON.parse(existing.destination_config_json) : {};

    const destinationConfig: Record<string, any> = {
        vendus_api_key: body.vendus_api_key || previousCfg.vendus_api_key,
        vendus_register_id: body.vendus_register_id ?? previousCfg.vendus_register_id ?? null,
        vendus_series_id: body.vendus_series_id ?? previousCfg.vendus_series_id ?? null,
        vendus_environment: body.vendus_environment === "sandbox" ? "sandbox" : "production",
    };

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.prepare(
        `INSERT INTO connections
          (id, user_id, source_kind, destination_kind, destination_config_json, status, created_at, updated_at)
         VALUES (?, ?, ?, 'vendus', ?, ?, ?, ?)
         ON CONFLICT(user_id, source_kind, destination_kind) DO UPDATE SET
           destination_config_json = excluded.destination_config_json,
           status = excluded.status,
           updated_at = excluded.updated_at`
    ).bind(id, authResult.targetUserId, sourceKind, JSON.stringify(destinationConfig), status, now, now).run();

    const response: Record<string, unknown> = { ok: true };
    if (sourceKind === "shopify") {
        response.warning = "Shopify-source via Vendus routes through the adapter pipeline. EU B2B reverse-charge is not yet supported on this path — use Shopify+InvoiceXpress for B2B EU.";
    }
    return NextResponse.json(response);
}

export async function DELETE(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const sourceKind = (new URL(request.url).searchParams.get("source_kind") ?? "stripe") === "shopify" ? "shopify" : "stripe";

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    await db.prepare(
        `DELETE FROM connections WHERE user_id = ? AND source_kind = ? AND destination_kind = 'vendus'`
    ).bind(authResult.targetUserId, sourceKind).run();

    return NextResponse.json({ ok: true });
}
