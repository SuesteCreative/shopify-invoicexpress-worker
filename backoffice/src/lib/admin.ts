import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";

// Role hierarchy: hiperadmin > superadmin > user
// isAdmin = true for superadmin and hiperadmin (can access admin features)
export async function isAdmin(userId?: string | null) {
    const role = await getRole(userId);
    return role === "superadmin" || role === "hiperadmin";
}

export async function isSuperAdmin(userId?: string | null) {
    const role = await getRole(userId);
    return role === "superadmin" || role === "hiperadmin";
}

export async function isHiperadmin(userId?: string | null) {
    const role = await getRole(userId);
    return role === "hiperadmin";
}

export async function getRole(userId?: string | null): Promise<string> {
    if (!userId) {
        const session = await auth();
        userId = session.userId;
    }
    if (!userId) return "user";

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return "user";

    const user: any = await db.prepare("SELECT role FROM users WHERE id = ?").bind(userId).first();
    return user?.role || "user";
}

export async function getImpersonationId(request: Request) {
    const cookie = request.headers.get("cookie");
    if (!cookie) return null;
    const match = cookie.match(/rioko_impersonate_id=([^;]+)/);
    return match ? match[1] : null;
}
