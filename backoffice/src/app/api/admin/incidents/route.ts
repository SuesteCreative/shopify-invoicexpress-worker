import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";

export const runtime = "edge";

/**
 * Phase 4a.1 — Superadmin incidents browser.
 *
 * GET ?status=open|all&user_id=...&kind=...&limit=N — list incidents
 * PATCH body { id, status } — set status to acknowledged | resolved
 */

const ALLOWED_STATUSES = ["open", "acknowledged", "resolved", "auto_resolved"] as const;

export async function GET(request: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        if (!await isAdmin(userId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

        const { env } = getRequestContext();
        const db = (env as any).DB;
        if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

        const params = request.nextUrl.searchParams;
        const status = params.get("status") ?? "open";
        const filterUserId = params.get("user_id");
        const filterKind = params.get("kind");
        const limit = Math.min(parseInt(params.get("limit") ?? "100", 10) || 100, 500);

        // Qualified with `i.` because of the join below — `status` alone would be
        // ambiguous the moment another joined table grows one.
        const where: string[] = [];
        const binds: any[] = [];
        if (status !== "all") {
            where.push("i.status = ?");
            binds.push(status);
        }
        if (filterUserId) {
            where.push("i.user_id = ?");
            binds.push(filterUserId);
        }
        if (filterKind) {
            where.push("i.kind = ?");
            binds.push(filterKind);
        }

        const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
        // The merchant label is joined in so the triage view can group by company:
        // `user_id` alone makes every row read as an anonymous id, which is the
        // reason incident lists get skimmed rather than worked.
        const sql = `SELECT i.id, i.user_id, i.connection_id, i.severity, i.kind, i.summary,
                            i.detail_json, i.affected_ids_json, i.status, i.first_seen_at,
                            i.last_seen_at, i.occurrences, i.notified_at, i.resolved_at,
                            COALESCE(NULLIF(u.admin_label, ''), NULLIF(u.company_name, ''), u.name, u.email) AS merchant_label
                       FROM incidents i
                       LEFT JOIN users u ON u.id = i.user_id
                     ${whereSql}
                     ORDER BY i.last_seen_at DESC LIMIT ?`;
        binds.push(limit);

        const result = await db.prepare(sql).bind(...binds).all();
        return NextResponse.json({ incidents: result.results ?? [] });
    } catch (e: any) {
        console.error("[incidents] GET error:", e);
        return NextResponse.json({ error: `Internal Server Error: ${e.message}` }, { status: 500 });
    }
}

export async function PATCH(request: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        if (!await isAdmin(userId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

        const body = await request.json() as { id?: string; status?: string };
        if (!body.id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
        if (!body.status || !ALLOWED_STATUSES.includes(body.status as any)) {
            return NextResponse.json({ error: `status must be one of: ${ALLOWED_STATUSES.join(", ")}` }, { status: 400 });
        }

        const { env } = getRequestContext();
        const db = (env as any).DB;
        if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

        const nowIso = new Date().toISOString();
        const resolvedAt = body.status === "resolved" || body.status === "auto_resolved" ? nowIso : null;

        await db.prepare(
            "UPDATE incidents SET status = ?, resolved_at = ? WHERE id = ?"
        ).bind(body.status, resolvedAt, body.id).run();

        const row: any = await db.prepare(
            "SELECT id, status, resolved_at FROM incidents WHERE id = ?"
        ).bind(body.id).first();

        return NextResponse.json({ incident: row });
    } catch (e: any) {
        console.error("[incidents] PATCH error:", e);
        return NextResponse.json({ error: `Internal Server Error: ${e.message}` }, { status: 500 });
    }
}
