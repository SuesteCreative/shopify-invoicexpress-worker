import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getImpersonationId } from "@/lib/admin";
import { RIOKO_CONFIG } from "@/lib/config";
import { callWorkerJson } from "@/lib/worker";

export const runtime = "edge";

const WORKER_BASE = RIOKO_CONFIG.workerUrl.replace(/\/$/, "");

/**
 * Lodgify source connection management.
 *
 * Stores the Lodgify API key and asks the WORKER to register the webhooks on
 * Lodgify's side. This route makes no Lodgify calls of its own: Lodgify
 * allowlists us by IP address and Cloudflare Pages has no fixed egress IP, so
 * anything that leaves from here is unallowlisted. The signing secrets are
 * stored by the Worker in `connections.source_config_json` so it can verify
 * inbound payloads.
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

            // Save the key FIRST, then let the WORKER register the webhooks.
            //
            // This route used to call Lodgify directly. It must not: Cloudflare
            // Pages has no fixed egress IP either, and Lodgify blocked us for
            // exactly that — requesting several end users' data from a
            // constantly changing set of addresses. Support confirmed in writing
            // (2026-08-18) that they can only allowlist by IP, so every Lodgify
            // call has to leave through the one relay they trust.
            //
            // The Worker's /admin/lodgify/reregister-webhooks does the same job
            // through that relay, registers all THREE events instead of one, and
            // stores the signing secrets itself. Which flips the ordering: the
            // connection row has to exist before the Worker can find it.
            const sourceCfg: Record<string, any> = { ...previousCfg, api_key: apiKey };
            // A resubmitted key invalidates the secrets minted against the old
            // one; keeping them would fail inbound verification silently.
            if (body.api_key && body.api_key !== previousCfg.api_key) {
                for (const k of ["webhook_secret", "webhook_id", "webhook_secret_change",
                    "webhook_id_change", "webhook_secret_declined", "webhook_id_declined"]) delete sourceCfg[k];
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

            // Best-effort, exactly as before: a registration failure must not
            // lose the key the merchant just typed.
            let needsManualWebhook = true;
            try {
                const reg = await callWorkerJson<{ ok?: boolean; results?: Record<string, any> }>(
                    "/admin/lodgify/reregister-webhooks",
                    { method: "POST", body: JSON.stringify({ userId: authResult.targetUserId }) },
                );
                // Lodgify returns no signing secret on some accounts, per event.
                // Manual setup is needed unless at least one event came back
                // with one — that is what `needs_manual_webhook` has always meant.
                const results = ((reg.data as any)?.results ?? {}) as Record<string, any>;
                needsManualWebhook = !reg.ok || !Object.values(results).some(r => r?.ok && r?.hasSecret);
                if (!reg.ok) {
                    console.warn("[Lodgify] reregister via worker failed:", reg.status,
                        JSON.stringify(reg.data).slice(0, 300));
                }
            } catch (e: any) {
                console.warn("[Lodgify] reregister via worker exception:", e?.message ?? e);
            }

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
        // Through the Worker, for the same reason onboarding is: Pages has no
        // fixed egress IP, and Lodgify only allowlists by IP. The Worker route
        // drops ALL webhooks pointing at us, not just the one id we happened to
        // store, so a re-registered connection does not leave orphans behind.
        try {
            await callWorkerJson("/admin/lodgify/unregister-webhooks", {
                method: "POST",
                body: JSON.stringify({ userId: authResult.targetUserId }),
            });
        } catch {
            // Best-effort; proceed with DB delete regardless
        }
    }

    await db.prepare(
        `DELETE FROM connections WHERE user_id = ? AND source_kind = 'lodgify' AND destination_kind = ?`
    ).bind(authResult.targetUserId, destinationKind).run();

    return NextResponse.json({ ok: true });
}
