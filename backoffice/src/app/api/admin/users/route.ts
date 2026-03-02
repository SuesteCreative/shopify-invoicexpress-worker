import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, isSuperAdmin, isHiperadmin, getRole, getImpersonationId } from "@/lib/admin";

export const runtime = "edge";

/** GET /api/admin/users */
export async function GET(request: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId || !(await isAdmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        // When impersonating, the visible role is the IMPERSONATED user's role, not the real admin's.
        // This ensures e.g. a superadmin impersonating another superadmin cannot see hiperadmin accounts.
        const impersonationId = await getImpersonationId(request);
        const viewerUserId = impersonationId || userId;  // who is *viewing* the page
        const viewerRole = await getRole(viewerUserId);

        const { env } = getRequestContext();
        const db = (env as any).DB;

        const results = await db.prepare(`
      SELECT 
        u.id, u.email, u.name, u.role, u.last_login, u.created_at,
        u.nif, u.company_name, u.fiscal_address, u.phone, u.website, u.registration_completed,
        i.shopify_domain, i.shopify_authorized, i.shopify_error,
        i.ix_authorized, i.ix_error,
        CASE WHEN i.shopify_token IS NOT NULL AND i.ix_api_key IS NOT NULL THEN 1 ELSE 0 END as is_connected
      FROM users u
      LEFT JOIN integrations i ON u.id = i.user_id
      ORDER BY u.created_at DESC
    `).all();

        let users = results.results as any[];

        // Filter visible users based on the VIEWER's role (impersonation-aware)
        if (viewerRole === "superadmin") {
            // Superadmin CANNOT see hiperadmin — hiperadmin is invisible to everyone except itself
            users = users.filter((u: any) => u.role !== "hiperadmin");
        }
        // hiperadmin (viewing as themselves) sees everyone

        // Return viewer metadata so the frontend can determine its own capabilities without relying on Clerk
        return NextResponse.json({ users, _viewer_role: viewerRole, _viewer_id: viewerUserId });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

/** PATCH /api/admin/users — change user role */
export async function PATCH(request: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId || !(await isSuperAdmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const callerRole = await getRole(userId);
        const { targetId, role } = await request.json() as { targetId: string; role: string };

        // Valid target roles depending on caller
        const hiperadminRoles = ["superadmin", "user"];
        const superadminRoles = ["user"];
        const allowedRoles = callerRole === "hiperadmin" ? hiperadminRoles : superadminRoles;

        if (!targetId || !allowedRoles.includes(role)) {
            return NextResponse.json({ error: `Role '${role}' not allowed for your level` }, { status: 400 });
        }

        const { env } = getRequestContext();
        const db = (env as any).DB;
        const target: any = await db.prepare("SELECT role FROM users WHERE id = ?").bind(targetId).first();

        // Only hiperadmin can act on hiperadmin or superadmin accounts
        if (target?.role === "hiperadmin") {
            return NextResponse.json({ error: "Cannot change hiperadmin role" }, { status: 403 });
        }
        if (target?.role === "superadmin" && callerRole !== "hiperadmin") {
            return NextResponse.json({ error: "Only hiperadmin can change superadmin role" }, { status: 403 });
        }

        await db.prepare("UPDATE users SET role = ? WHERE id = ?").bind(role, targetId).run();
        return NextResponse.json({ success: true });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

/** DELETE /api/admin/users — removes user from D1 only */
export async function DELETE(request: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId || !(await isAdmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const callerRole = await getRole(userId);
        const { targetId } = await request.json() as { targetId: string };
        if (!targetId) return NextResponse.json({ error: "Missing targetId" }, { status: 400 });

        const { env } = getRequestContext();
        const db = (env as any).DB;
        const target: any = await db.prepare("SELECT role FROM users WHERE id = ?").bind(targetId).first();

        if (target?.role === "hiperadmin") return NextResponse.json({ error: "Cannot delete hiperadmin" }, { status: 403 });
        if (target?.role === "superadmin" && callerRole !== "hiperadmin") return NextResponse.json({ error: "Only hiperadmin can delete superadmins" }, { status: 403 });

        await db.prepare("DELETE FROM integrations WHERE user_id = ?").bind(targetId).run();
        await db.prepare("DELETE FROM logs WHERE shopify_domain = (SELECT shopify_domain FROM integrations WHERE user_id = ?)").bind(targetId).run().catch(() => { });
        await db.prepare("DELETE FROM users WHERE id = ?").bind(targetId).run();

        return NextResponse.json({ success: true });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
