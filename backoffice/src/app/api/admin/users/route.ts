import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, isSuperAdmin } from "@/lib/admin";

export const runtime = "edge";

/** GET /api/admin/users — list all users with integration status */
export async function GET(request: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId || !(await isAdmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const callerIsSuperAdmin = await isSuperAdmin(userId);

        const { env } = getRequestContext();
        const db = (env as any).DB;

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

        let users = results.results as any[];

        // Regular admins cannot see the superadmin account
        if (!callerIsSuperAdmin) {
            users = users.filter((u: any) => u.role !== "superadmin");
        }

        return NextResponse.json(users);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

/** PATCH /api/admin/users — promote/demote a user to/from admin role */
export async function PATCH(request: NextRequest) {
    try {
        const { userId } = await auth();
        // Only superadmin can change roles
        if (!userId || !(await isSuperAdmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { targetId, role } = await request.json() as { targetId: string; role: "admin" | "user" };

        if (!targetId || !["admin", "user"].includes(role)) {
            return NextResponse.json({ error: "Invalid params" }, { status: 400 });
        }

        // Protect superadmin account from role changes
        const { env } = getRequestContext();
        const db = (env as any).DB;
        const target: any = await db.prepare("SELECT role FROM users WHERE id = ?").bind(targetId).first();
        if (target?.role === "superadmin") {
            return NextResponse.json({ error: "Cannot change superadmin role" }, { status: 403 });
        }

        await db.prepare("UPDATE users SET role = ? WHERE id = ?").bind(role, targetId).run();
        return NextResponse.json({ success: true });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

/** DELETE /api/admin/users — removes user from D1 only (Clerk account preserved so re-register is possible) */
export async function DELETE(request: NextRequest) {
    try {
        const { userId } = await auth();
        const callerIsSuperAdmin = await isSuperAdmin(userId);

        // Both admins and superadmins can delete, with restrictions
        if (!userId || !(await isAdmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { targetId } = await request.json() as { targetId: string };
        if (!targetId) return NextResponse.json({ error: "Missing targetId" }, { status: 400 });

        const { env } = getRequestContext();
        const db = (env as any).DB;

        const target: any = await db.prepare("SELECT role FROM users WHERE id = ?").bind(targetId).first();

        // Nobody can delete the superadmin. Admins cannot delete other admins.
        if (target?.role === "superadmin") {
            return NextResponse.json({ error: "Cannot delete superadmin" }, { status: 403 });
        }
        if (!callerIsSuperAdmin && target?.role === "admin") {
            return NextResponse.json({ error: "Admins cannot delete other admins" }, { status: 403 });
        }

        // Delete integration data first (FK ordering), then the user
        await db.prepare("DELETE FROM integrations WHERE user_id = ?").bind(targetId).run();
        await db.prepare("DELETE FROM processed_orders WHERE id IN (SELECT id FROM logs WHERE shopify_domain = (SELECT shopify_domain FROM integrations WHERE user_id = ?))").bind(targetId).run().catch(() => { });
        await db.prepare("DELETE FROM logs WHERE shopify_domain = (SELECT shopify_domain FROM integrations WHERE user_id = ?)").bind(targetId).run().catch(() => { });
        await db.prepare("DELETE FROM users WHERE id = ?").bind(targetId).run();

        // NOTE: Clerk account is intentionally NOT deleted — the user can re-register
        // and a new row will be created in D1 via the /api/auth/sync endpoint.

        return NextResponse.json({ success: true });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
