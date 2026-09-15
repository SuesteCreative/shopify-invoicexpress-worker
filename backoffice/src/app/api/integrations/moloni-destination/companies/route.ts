import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/account";
import { sourceKindOrNull, unknownSourceKindError } from "@/lib/connection-kinds";
import { listMoloniCompanies, moloniConnectionToken } from "@/lib/moloni-token";

export const runtime = "edge";

async function resolveTargetUser(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return { error: "Unauthorized", status: 401 as const };
    let targetUserId = await resolveAccountUser(request, userId);
    return { userId, targetUserId };
}

/**
 * The Moloni companies this connection can see — and, for the wizards, the proof
 * that its credential works.
 *
 * It used to hand the stored username and password to a worker proxy that only
 * knows the password grant. For an OAuth connection that could only fail, and
 * every new Moloni connection is OAuth since 15/09/2026. The token now comes from
 * the connection, whichever way it authenticates.
 */
export async function GET(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    const rawSource = new URL(request.url).searchParams.get("source_kind");
    const sourceKind = sourceKindOrNull(rawSource, "stripe");
    if (!sourceKind) return NextResponse.json({ error: unknownSourceKindError(rawSource) }, { status: 400 });

    const conn = await moloniConnectionToken(db, authResult.targetUserId, sourceKind);
    if (!conn.ok) return NextResponse.json({ error: conn.error }, { status: conn.status });

    try {
        return NextResponse.json({ companies: await listMoloniCompanies(conn.cfg, conn.token) });
    } catch (e: any) {
        return NextResponse.json({ error: String(e?.message ?? e) }, { status: 502 });
    }
}
