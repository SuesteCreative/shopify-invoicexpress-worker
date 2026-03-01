import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

/**
 * POST /api/integrations/webhooks-confirm
 * Marks webhooks_active = 1 for the current user's integration
 * without requiring write_webhooks scope — used for manual installations.
 */
export async function POST(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return new NextResponse("Unauthorized", { status: 401 });

    // Support Superadmin impersonation
    const impersonatedId = request.headers.get("x-impersonated-user-id");
    const targetUserId = impersonatedId || userId;

    try {
        const { env } = getRequestContext();
        const db = (env as any).DB;
        if (!db) {
            console.error("D1 Binding 'DB' not found in env");
            return NextResponse.json({ error: "DB not available" }, { status: 500 });
        }

        await db.prepare(
            "UPDATE integrations SET webhooks_active = 1, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?"
        ).bind(targetUserId).run();

        return NextResponse.json({ success: true });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
