import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getImpersonationId } from "@/lib/admin";
import { RIOKO_CONFIG } from "@/lib/config";

export const runtime = "edge";

const WORKER_BASE = RIOKO_CONFIG.workerUrl.replace(/\/$/, "");

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
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    const rawSource = new URL(request.url).searchParams.get("source_kind") ?? "stripe";
    const sourceKind = rawSource === "shopify" ? "shopify" : "stripe";

    const row: any = await db.prepare(
        `SELECT destination_config_json FROM connections
         WHERE user_id = ? AND source_kind = ? AND destination_kind = 'moloni' LIMIT 1`
    ).bind(authResult.targetUserId, sourceKind).first();

    if (!row?.destination_config_json) {
        return NextResponse.json({ error: "Moloni credentials not found — save Step 2 first." }, { status: 404 });
    }

    const cfg = JSON.parse(row.destination_config_json);

    // Proxy through the Worker — CF Pages edge functions cannot reliably reach
    // external APIs. The Worker runtime has no such restriction.
    const workerRes = await fetch(`${WORKER_BASE}/moloni-proxy/companies`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({
            client_id: cfg.moloni_client_id,
            client_secret: cfg.moloni_client_secret,
            username: cfg.moloni_username,
            password: cfg.moloni_password,
            environment: cfg.moloni_environment ?? "production",
        }),
    });

    const data: any = await workerRes.json().catch(() => ({}));
    if (!workerRes.ok) {
        return NextResponse.json({ error: data?.error ?? `Worker error ${workerRes.status}` }, { status: 502 });
    }
    return NextResponse.json(data);
}
