import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";

export const runtime = "edge";

/**
 * Read the configuration trail.
 *
 * `config_audit` has been written to since the admin console's field editor
 * shipped, and until now nothing could read it — which made it useless at the
 * only moment it mattered. When Farracemota's InvoiceXpress credentials were
 * blanked eleven minutes after being validated, the honest answer to "who did
 * this" was that the product had not kept one.
 *
 * Values are already redacted at write time (see lib/config-audit): a
 * credential is stored as a presence marker, never as itself, so this endpoint
 * has no secret to leak.
 *
 *   GET /api/admin/config-audit?user_id=user_…&limit=100
 *   GET /api/admin/config-audit?field=ix_api_key      — fleet-wide, one field
 */
export async function GET(request: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId || !(await isAdmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { env } = getRequestContext();
        const db = (env as any).DB;
        if (!db) return NextResponse.json({ error: "No database binding" }, { status: 500 });

        const params = new URL(request.url).searchParams;
        const targetUser = params.get("user_id");
        const field = params.get("field");
        const limit = Math.min(Math.max(Number(params.get("limit") ?? 200), 1), 1000);

        const where: string[] = [];
        const binds: unknown[] = [];
        if (targetUser) { where.push("a.user_id = ?"); binds.push(targetUser); }
        if (field) { where.push("a.field = ?"); binds.push(field); }

        const rows = await db.prepare(
            `SELECT a.id, a.user_id, a.actor, a.scope, a.field, a.old_value, a.new_value, a.created_at,
                    u.company_name, u.admin_label, u.email
               FROM config_audit a
               LEFT JOIN users u ON u.id = a.user_id
              ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
              ORDER BY a.created_at DESC
              LIMIT ?`
        ).bind(...binds, limit).all().catch(() => ({ results: [] }));

        return NextResponse.json({ entries: rows.results ?? [] });
    } catch (error: any) {
        console.error("[admin/config-audit] GET failed:", error?.message ?? error);
        return NextResponse.json({ error: "read_failed" }, { status: 500 });
    }
}
