import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/account";
import { sourceKindOrNull, unknownSourceKindError } from "@/lib/connection-kinds";
import { listMoloniDocumentSets, moloniConnectionToken } from "@/lib/moloni-token";

export const runtime = "edge";

async function resolveTargetUser(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return { error: "Unauthorized", status: 401 as const };
    let targetUserId = await resolveAccountUser(request, userId);
    return { userId, targetUserId };
}

/**
 * One company's Moloni document sets, for this connection.
 *
 * Authenticates the way the connection does — see `moloniConnectionToken`. The
 * password-only worker proxy it used to call could not serve an OAuth connection.
 */
export async function GET(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const url = new URL(request.url);
    const companyId = Number(url.searchParams.get("company_id") ?? 0);
    if (!companyId) return NextResponse.json({ error: "company_id is required" }, { status: 400 });

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    const rawSource = url.searchParams.get("source_kind");
    const sourceKind = sourceKindOrNull(rawSource, "stripe");
    if (!sourceKind) return NextResponse.json({ error: unknownSourceKindError(rawSource) }, { status: 400 });

    const conn = await moloniConnectionToken(db, authResult.targetUserId, sourceKind);
    if (!conn.ok) return NextResponse.json({ error: conn.error }, { status: conn.status });

    try {
        return NextResponse.json({ documentSets: await listMoloniDocumentSets(conn.cfg, conn.token, companyId) });
    } catch (e: any) {
        return NextResponse.json({ error: String(e?.message ?? e) }, { status: 502 });
    }
}
