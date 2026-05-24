import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getImpersonationId } from "@/lib/admin";

export const runtime = "edge";

/**
 * Last 10 log entries (any severity) for the current user's shop.
 *
 * The `logs` table is keyed by `shopify_domain`, so we look up the user's
 * integration first and then filter. Includes everything: successful
 * webhook handling, skips (paused / already-processed), gate blocks,
 * destination failures. The card maps `status` → severity.
 */
export async function GET(request: NextRequest) {
    try {
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
            .prepare("SELECT shopify_domain FROM integrations WHERE user_id = ?")
            .bind(targetUserId)
            .first();

        if (!integration || !integration.shopify_domain) {
            return NextResponse.json({ logs: [] });
        }

        const rows: any = await db
            .prepare(
                "SELECT id, topic, response, status, created_at " +
                "FROM logs WHERE shopify_domain = ? " +
                "ORDER BY created_at DESC LIMIT 10"
            )
            .bind(integration.shopify_domain)
            .all();

        // `response` is stored as JSON.stringify() — try to parse so the UI
        // can show a clean message instead of escaped JSON. Falls back to raw.
        const logs = (rows?.results || []).map((r: any) => {
            let message: string = r.response ?? "";
            try {
                const parsed = JSON.parse(r.response);
                if (typeof parsed === "string") message = parsed;
                else if (parsed?.message) message = String(parsed.message);
                else if (parsed?.error) message = String(parsed.error);
                else message = r.response;
            } catch { /* keep raw string */ }
            return {
                id: r.id,
                topic: r.topic,
                status: r.status,
                message,
                created_at: r.created_at,
            };
        });

        return NextResponse.json({ logs });
    } catch (error: any) {
        console.error("[/api/dashboard/recent-logs] D1 Error:", error);
        return NextResponse.json({ error: `Internal Server Error: ${error.message}` }, { status: 500 });
    }
}
