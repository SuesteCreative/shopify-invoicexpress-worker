import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getImpersonationId } from "@/lib/admin";
import { RIOKO_CONFIG } from "@/lib/config";

export const runtime = "edge";

const WORKER_BASE = RIOKO_CONFIG.workerUrl.replace(/\/$/, "");
const LODGIFY_API = "https://api.lodgify.com";

/**
 * Lodgify source connection management.
 *
 * Stores the Lodgify API key and auto-registers a webhook on Lodgify's side
 * (POST /v2/webhooks). The returned signing secret is stored in
 * `connections.source_config_json` so the worker can verify inbound payloads.
 *
 * Webhook URL registered on Lodgify:
 *     POST https://<worker-host>/webhooks/lodgify/<user_id>
 *
 * source_config_json shape:
 *   { api_key, webhook_secret, webhook_id }
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

function maskKey(s: string): string {
    if (s.length <= 8) return "•".repeat(s.length);
    return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

function redact(cfg: Record<string, unknown>) {
    return {
        has_api_key: !!cfg.api_key,
        api_key_masked: cfg.api_key ? maskKey(String(cfg.api_key)) : null,
        has_webhook_secret: !!cfg.webhook_secret,
        webhook_id: cfg.webhook_id ?? null,
    };
}

export async function GET(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    const destinationKindParam = new URL(request.url).searchParams.get("destination_kind") ?? "invoicexpress";

    const row: any = await db.prepare(
        `SELECT id, status, source_config_json, destination_kind, created_at, updated_at
         FROM connections WHERE user_id = ? AND source_kind = 'lodgify' AND destination_kind = ?`
    ).bind(authResult.targetUserId, destinationKindParam).first();

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
            webhook_url: `${WORKER_BASE}/webhooks/lodgify/${authResult.targetUserId}`,
        },
    });
}

export async function POST(request: NextRequest) {
    try {
        const authResult = await resolveTargetUser(request);
        if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

        const body = await request.json() as {
            api_key?: string;
            destination_kind?: "invoicexpress" | "moloni" | "vendus";
            status?: "draft" | "active" | "paused" | "error";
        };

        const destinationKind = ["invoicexpress", "moloni", "vendus"].includes(body.destination_kind || "")
            ? body.destination_kind!
            : "invoicexpress";

        const status = ["draft", "active", "paused", "error"].includes(body.status || "") ? body.status! : "active";

        const { env } = getRequestContext();
        const db = (env as any).DB;
        if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

        // Load existing config to preserve api_key if not re-submitted
        const existing: any = await db.prepare(
            `SELECT source_config_json FROM connections
             WHERE user_id = ? AND source_kind = 'lodgify' AND destination_kind = ? LIMIT 1`
        ).bind(authResult.targetUserId, destinationKind).first();
        const previousCfg: Record<string, any> = existing?.source_config_json
            ? JSON.parse(existing.source_config_json)
            : {};

        const apiKey = body.api_key || previousCfg.api_key;
        if (status === "active" && !apiKey) {
            return NextResponse.json({ error: "api_key is required to activate the connection" }, { status: 400 });
        }

        if (status === "active" && apiKey) {
            const webhookUrl = `${WORKER_BASE}/webhooks/lodgify/${authResult.targetUserId}`;

            // Attempt webhook registration best-effort — never block the response on this
            let webhookSecret: string | null = null;
            let webhookId = "";
            let needsManualWebhook = false;

            try {
                const ac = new AbortController();
                const tId = setTimeout(() => ac.abort(), 8_000);

                if (previousCfg.webhook_id) {
                    await fetch(`${LODGIFY_API}/v2/webhooks/${previousCfg.webhook_id}`, {
                        method: "DELETE",
                        headers: { "X-ApiKey": apiKey },
                        signal: ac.signal,
                    }).catch(() => null);
                }

                const regRes = await fetch(`${LODGIFY_API}/v2/webhooks`, {
                    method: "POST",
                    headers: {
                        "X-ApiKey": apiKey,
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                    },
                    body: JSON.stringify({ url: webhookUrl, event: "booking_new_booked", isActive: true }),
                    signal: ac.signal,
                });
                clearTimeout(tId);

                if (regRes.ok) {
                    const regData: any = await regRes.json().catch(() => ({}));
                    console.log("[Lodgify] webhook reg:", JSON.stringify(regData));
                    webhookSecret = regData.secret ?? regData.signing_secret ?? regData.key ?? null;
                    webhookId = String(regData.id ?? regData.webhook_id ?? "");
                } else {
                    console.warn("[Lodgify] webhook reg failed:", regRes.status, await regRes.text().catch(() => ""));
                    needsManualWebhook = true;
                }
            } catch (e: any) {
                console.warn("[Lodgify] webhook reg exception:", e?.message ?? e);
                needsManualWebhook = true;
            }

            if (!webhookSecret) needsManualWebhook = true;

            const sourceCfg: Record<string, any> = { api_key: apiKey };
            if (webhookSecret) {
                sourceCfg.webhook_secret = webhookSecret;
                sourceCfg.webhook_id = webhookId;
            }

            const id = crypto.randomUUID();
            const now = new Date().toISOString();

            await db.prepare(
                `INSERT INTO connections
                  (id, user_id, source_kind, destination_kind, source_config_json, status, created_at, updated_at)
                 VALUES (?, ?, 'lodgify', ?, ?, 'active', ?, ?)
                 ON CONFLICT(user_id, source_kind, destination_kind) DO UPDATE SET
                   source_config_json = excluded.source_config_json,
                   status = excluded.status,
                   updated_at = excluded.updated_at`
            ).bind(id, authResult.targetUserId, destinationKind, JSON.stringify(sourceCfg), now, now).run();

            return NextResponse.json({ ok: true, webhook_url: webhookUrl, needs_manual_webhook: needsManualWebhook });
        }

        // Non-active status update (pause/draft) — just update status, preserve config
        const now = new Date().toISOString();
        await db.prepare(
            `UPDATE connections SET status = ?, updated_at = ?
             WHERE user_id = ? AND source_kind = 'lodgify' AND destination_kind = ?`
        ).bind(status, now, authResult.targetUserId, destinationKind).run();

        return NextResponse.json({ ok: true });
    } catch (e: any) {
        console.error("[Lodgify POST] fatal:", e?.message ?? e);
        return NextResponse.json({ error: `Erro interno: ${e?.message ?? "unknown"}` }, { status: 500 });
    }
}

export async function DELETE(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const destinationKind = new URL(request.url).searchParams.get("destination_kind") ?? "invoicexpress";

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    // Try to deregister webhook from Lodgify before deleting the row
    const row: any = await db.prepare(
        `SELECT source_config_json FROM connections
         WHERE user_id = ? AND source_kind = 'lodgify' AND destination_kind = ? LIMIT 1`
    ).bind(authResult.targetUserId, destinationKind).first();

    if (row?.source_config_json) {
        try {
            const cfg = JSON.parse(row.source_config_json);
            if (cfg.webhook_id && cfg.api_key) {
                await fetch(`${LODGIFY_API}/v2/webhooks/${cfg.webhook_id}`, {
                    method: "DELETE",
                    headers: { "X-ApiKey": cfg.api_key },
                });
            }
        } catch {
            // Best-effort; proceed with DB delete regardless
        }
    }

    await db.prepare(
        `DELETE FROM connections WHERE user_id = ? AND source_kind = 'lodgify' AND destination_kind = ?`
    ).bind(authResult.targetUserId, destinationKind).run();

    return NextResponse.json({ ok: true });
}
