import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth, currentUser } from "@clerk/nextjs/server";

export async function isAdmin(userId?: string | null) {
    if (!userId) {
        const session = await auth();
        userId = session.userId;
    }

    if (!userId) return false;

    const { env } = getRequestContext();
    const db = (env as any).DB;

    if (!db) return false;

    const user: any = await db.prepare("SELECT role FROM users WHERE id = ?").bind(userId).first();
    return user?.role === "admin";
}

export async function getImpersonationId(request: Request) {
    const cookie = request.headers.get("cookie");
    if (!cookie) return null;

    const match = cookie.match(/rioko_impersonate_id=([^;]+)/);
    return match ? match[1] : null;
}
