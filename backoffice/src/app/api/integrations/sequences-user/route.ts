import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/account";
import { listIxSequences } from "@/lib/ix-sequences";

export const runtime = "edge";

/**
 * Reads the authenticated user's stored IX credentials from D1 and proxies
 * the IX /sequences.json call. Unlike /api/integrations/sequences (which
 * requires explicit account+apiKey query params for the setup wizard), this
 * endpoint is used by pages where the integration is already configured.
 */
export async function GET(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    let targetUserId = await resolveAccountUser(request, userId);

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    // Shared with the rule form, which has to refuse a series the account does
    // not have. `null` there means "could not tell"; this endpoint has always
    // answered with an empty list either way, and keeps doing so.
    // `source_kind` only picks between two InvoiceXpress connections on one
    // account; absent, the most recently updated one answers.
    const sequences = await listIxSequences(
        db, targetUserId, request.nextUrl.searchParams.get("source_kind") ?? undefined,
    );
    return NextResponse.json(sequences ?? []);
}
