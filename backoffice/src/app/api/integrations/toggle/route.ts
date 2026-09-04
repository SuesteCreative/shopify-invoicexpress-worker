import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/account";

export const runtime = "edge";

/**
 * Toggles `integrations.is_paused` for the current user (or impersonated
 * target). Decoupled from the main POST so it can be called from the toggle
 * UI without re-sending every other config field.
 */
export async function POST(request: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        let targetUserId = userId;
        targetUserId = await resolveAccountUser(request, userId);

        const body: any = await request.json().catch(() => ({}));
        const paused = !!body.paused;

        const { env } = getRequestContext();
        const db = (env as any).DB;
        if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

        const existing: any = await db
            .prepare("SELECT id FROM integrations WHERE user_id = ?")
            .bind(targetUserId)
            .first();

        if (!existing) {
            return NextResponse.json({ error: "No integration to toggle" }, { status: 404 });
        }

        await db
            .prepare("UPDATE integrations SET is_paused = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?")
            .bind(paused ? 1 : 0, targetUserId)
            .run();

        return NextResponse.json({ success: true, is_paused: paused ? 1 : 0 });
    } catch (error: any) {
        console.error("[/api/integrations/toggle] D1 Error:", error);
        return NextResponse.json({ error: `Failed to toggle integration: ${error.message}` }, { status: 500 });
    }
}
