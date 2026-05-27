import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getImpersonationId } from "@/lib/admin";

export const runtime = "edge";

/**
 * Moloni destination connection management.
 *
 * Writes Moloni OAuth credentials + company/document_set ids to
 * `connections.destination_config_json` for a given (user_id, source_kind) pair.
 * The worker's `MoloniDestination` adapter reads these via `ctx.destinationConfig`.
 *
 * For now only Stripe-source connections route through the adapter pipeline;
 * Shopify-source still uses the legacy IX-direct handlers until the migration
 * tracked in implementation.md lands. Calls with `source_kind=shopify` are
 * accepted (row is written) but a warning is returned so the UI can surface it.
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

type MoloniBody = {
    source_kind?: "stripe" | "shopify";
    moloni_client_id?: string;
    moloni_client_secret?: string;
    moloni_username?: string;
    moloni_password?: string;
    moloni_company_id?: number | string;
    moloni_document_set_id?: number | string;
    moloni_environment?: "production" | "sandbox";
    vat_included?: boolean;
    auto_finalize?: boolean;
    exemption_reason?: string;
    status?: "draft" | "active" | "paused" | "error";
};

function redactConfig(cfg: Record<string, unknown>) {
    return {
        moloni_client_id: cfg.moloni_client_id ?? null,
        has_client_secret: !!cfg.moloni_client_secret,
        moloni_username: cfg.moloni_username ?? null,
        has_password: !!cfg.moloni_password,
        moloni_company_id: cfg.moloni_company_id ?? null,
        moloni_document_set_id: cfg.moloni_document_set_id ?? null,
        moloni_environment: cfg.moloni_environment ?? "production",
        vat_included: cfg.vat_included !== false,
        auto_finalize: cfg.auto_finalize === true,
        exemption_reason: cfg.exemption_reason ?? "M01",
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
             FROM connections WHERE user_id = ? AND source_kind = ? AND destination_kind = 'moloni' LIMIT 1`
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

    const body = await request.json() as MoloniBody;

    const sourceKind = body.source_kind === "shopify" ? "shopify" : "stripe";
    const status = ["draft", "active", "paused", "error"].includes(body.status || "") ? body.status! : "draft";

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    // Preserve existing credentials when body omits them (lets user save invoice
    // settings or partial drafts without re-pasting secrets).
    const existing: any = await db.prepare(
        `SELECT destination_config_json FROM connections
         WHERE user_id = ? AND source_kind = ? AND destination_kind = 'moloni' LIMIT 1`
    ).bind(authResult.targetUserId, sourceKind).first();
    const previousCfg = existing?.destination_config_json ? JSON.parse(existing.destination_config_json) : {};

    const merged = {
        moloni_client_id: body.moloni_client_id ?? previousCfg.moloni_client_id,
        moloni_client_secret: body.moloni_client_secret ?? previousCfg.moloni_client_secret,
        moloni_username: body.moloni_username ?? previousCfg.moloni_username,
        moloni_password: body.moloni_password ?? previousCfg.moloni_password,
        moloni_company_id: body.moloni_company_id ?? previousCfg.moloni_company_id,
        moloni_document_set_id: body.moloni_document_set_id ?? previousCfg.moloni_document_set_id,
        moloni_environment: body.moloni_environment ?? previousCfg.moloni_environment,
    };

    // Require full credentials for active status; drafts allow partial save.
    if (status === "active") {
        const required: Array<keyof typeof merged> = [
            "moloni_client_id", "moloni_client_secret", "moloni_username",
            "moloni_password", "moloni_company_id", "moloni_document_set_id",
        ];
        for (const field of required) {
            if (merged[field] === undefined || merged[field] === "" || merged[field] === null) {
                return NextResponse.json({ error: `Missing ${field}` }, { status: 400 });
            }
        }
    }

    const env_ = (merged.moloni_environment ?? body.moloni_environment) === "sandbox" ? "sandbox" : "production";

    const destinationConfig: Record<string, unknown> = {
        moloni_client_id: merged.moloni_client_id ? String(merged.moloni_client_id) : undefined,
        moloni_client_secret: merged.moloni_client_secret ? String(merged.moloni_client_secret) : undefined,
        moloni_username: merged.moloni_username ? String(merged.moloni_username) : undefined,
        moloni_password: merged.moloni_password ? String(merged.moloni_password) : undefined,
        moloni_company_id: merged.moloni_company_id !== undefined && merged.moloni_company_id !== null && merged.moloni_company_id !== "" ? Number(merged.moloni_company_id) : undefined,
        moloni_document_set_id: merged.moloni_document_set_id !== undefined && merged.moloni_document_set_id !== null && merged.moloni_document_set_id !== "" ? Number(merged.moloni_document_set_id) : undefined,
        moloni_environment: env_,
        vat_included: body.vat_included !== undefined ? body.vat_included : (previousCfg.vat_included !== false),
        auto_finalize: body.auto_finalize !== undefined ? body.auto_finalize === true : (previousCfg.auto_finalize === true),
        exemption_reason: typeof body.exemption_reason === "string" && body.exemption_reason.trim()
            ? body.exemption_reason.trim()
            : (previousCfg.exemption_reason ?? "M01"),
    };

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.prepare(
        `INSERT INTO connections
          (id, user_id, source_kind, destination_kind, destination_config_json, status, created_at, updated_at)
         VALUES (?, ?, ?, 'moloni', ?, ?, ?, ?)
         ON CONFLICT(user_id, source_kind, destination_kind) DO UPDATE SET
           destination_config_json = excluded.destination_config_json,
           status = excluded.status,
           updated_at = excluded.updated_at`
    ).bind(id, authResult.targetUserId, sourceKind, JSON.stringify(destinationConfig), status, now, now).run();

    const response: Record<string, unknown> = { ok: true };
    if (sourceKind === "shopify") {
        response.warning = "Shopify-source webhooks still use the legacy IX-direct handlers until the adapter pipeline migration lands. Moloni destination will only fire for Stripe-source connections.";
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
        `DELETE FROM connections WHERE user_id = ? AND source_kind = ? AND destination_kind = 'moloni'`
    ).bind(authResult.targetUserId, sourceKind).run();

    return NextResponse.json({ ok: true });
}
