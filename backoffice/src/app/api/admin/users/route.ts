import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";

export const runtime = "edge";

export async function GET() {
    try {
        const { userId } = await auth();
        if (!userId || !(await isAdmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { env } = getRequestContext();
        const db = (env as any).DB;

        // Join users with their integration status
        const results = await db.prepare(`
      SELECT 
        u.id, 
        u.email, 
        u.name, 
        u.role, 
        u.last_login,
        u.created_at,
        i.shopify_domain,
        i.shopify_authorized,
        i.shopify_error,
        i.ix_authorized,
        i.ix_error,
        CASE WHEN i.shopify_token IS NOT NULL AND i.ix_api_key IS NOT NULL THEN 1 ELSE 0 END as is_connected
      FROM users u
      LEFT JOIN integrations i ON u.id = i.user_id
        ORDER BY u.created_at DESC
    `).all();

        return NextResponse.json(results.results);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
