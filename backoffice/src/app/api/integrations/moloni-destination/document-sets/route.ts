import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/account";
import { callWorker } from "@/lib/worker";
import { sourceKindOrNull, unknownSourceKindError } from "@/lib/connection-kinds";

export const runtime = "edge";

async function resolveTargetUser(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return { error: "Unauthorized", status: 401 as const };
    let targetUserId = await resolveAccountUser(request, userId);
    return { userId, targetUserId };
}

export async function GET(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const url = new URL(request.url);
    const companyId = url.searchParams.get("company_id");
    if (!companyId) return NextResponse.json({ error: "company_id is required" }, { status: 400 });

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    // Same collapse as its sibling: `stripe_connect` and `lodgify` both became
    // `stripe`, so the series shown belonged to another integration.
    const rawSource = url.searchParams.get("source_kind");
    const sourceKind = sourceKindOrNull(rawSource, "stripe");
    if (!sourceKind) return NextResponse.json({ error: unknownSourceKindError(rawSource) }, { status: 400 });

    const row: any = await db.prepare(
        `SELECT destination_config_json FROM connections
         WHERE user_id = ? AND source_kind = ? AND destination_kind = 'moloni' LIMIT 1`
    ).bind(authResult.targetUserId, sourceKind).first();

    if (!row?.destination_config_json) {
        return NextResponse.json({ error: "Moloni credentials not found — save Step 2 first." }, { status: 404 });
    }

    const cfg = JSON.parse(row.destination_config_json);

    // callWorker carries the admin key the proxy requires.
    const workerRes = await callWorker("/moloni-proxy/document-sets", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({
            client_id: cfg.moloni_client_id,
            client_secret: cfg.moloni_client_secret,
            username: cfg.moloni_username,
            password: cfg.moloni_password,
            environment: cfg.moloni_environment ?? "production",
            company_id: companyId,
        }),
    });

    const data: any = await workerRes.json().catch(() => ({}));
    if (!workerRes.ok) {
        return NextResponse.json({ error: data?.error ?? `Worker error ${workerRes.status}` }, { status: 502 });
    }
    return NextResponse.json(data);
}
