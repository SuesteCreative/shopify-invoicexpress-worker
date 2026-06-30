import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getImpersonationId } from "@/lib/admin";

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

    let targetUserId = userId;
    if (await isAdmin(userId)) {
        const impersonationId = await getImpersonationId(request);
        if (impersonationId) targetUserId = impersonationId;
    }

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    const integration: any = await db
        .prepare("SELECT ix_account_name, ix_api_key, ix_environment FROM integrations WHERE user_id = ?")
        .bind(targetUserId)
        .first();

    if (!integration?.ix_account_name || !integration?.ix_api_key) {
        return NextResponse.json([]);
    }

    const { ix_account_name: account, ix_api_key: apiKey, ix_environment: environment } = integration;
    const isTest = environment !== "production";
    const suffix = isTest ? ".macewindu.invoicexpress.com" : ".invoicexpress.com";

    try {
        const res = await fetch(`https://${account}${suffix}/sequences.json?api_key=${apiKey}`, {
            headers: { "Accept": "application/json" },
        });
        if (!res.ok) return NextResponse.json([]);
        const data: any = await res.json();
        return NextResponse.json(data.sequences ?? []);
    } catch {
        return NextResponse.json([]);
    }
}
