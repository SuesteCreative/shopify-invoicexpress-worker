import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";

// Role hierarchy: hiperadmin > superadmin > user
// isAdmin = true for superadmin and hiperadmin (can access admin features)
//
// There used to be an isSuperAdmin() beside this, byte-for-byte the same
// predicate. The name promised a distinction the code did not make, and that is
// how /client-rules ended up gated at "superadmin" while its only mutating verb
// and the nav link both required hiperadmin. One predicate, one name.
export async function isAdmin(userId?: string | null) {
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

export interface DevModeTarget {
    id: string;
    /** Display only, and nullable in D1 — coalesced so the panel's header reads
     *  the same as it always did (React renders null and "" identically). */
    name: string;
    email: string;
    /** Defaulted the way getRole() defaults it, so a null role is "user" here
     *  too rather than failing an === against "superadmin". */
    role: string;
    nif: string | null;
    company_name: string | null;
    shopify_domain: string | null;
    shopify_authorized: boolean;
    ix_authorized: boolean;
    shopify_error: string | null;
    ix_error: string | null;
    is_inactive: boolean;
}

/** The account a dev-mode page is about. Lives here rather than inline in the
 *  page because two route trees render that panel during the /admin changeover,
 *  and a JOIN copied into both is a JOIN that drifts. Returns null when there is
 *  no such user, so the caller decides between notFound() and a redirect. */
export async function getDevModeTarget(id: string): Promise<DevModeTarget | null> {
    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return null;

    const t: any = await db.prepare(`
      SELECT u.id, u.name, u.email, u.role, u.nif, u.company_name,
             COALESCE(u.is_inactive, 0) AS is_inactive,
             i.shopify_domain, i.shopify_authorized, i.ix_authorized,
             i.shopify_error, i.ix_error
      FROM users u
      LEFT JOIN integrations i ON u.id = i.user_id
      WHERE u.id = ?
    `).bind(id).first();

    if (!t) return null;

    return {
        id: t.id,
        name: t.name ?? "",
        email: t.email ?? "",
        role: t.role || "user",
        nif: t.nif,
        company_name: t.company_name,
        shopify_domain: t.shopify_domain,
        shopify_authorized: !!t.shopify_authorized,
        ix_authorized: !!t.ix_authorized,
        shopify_error: t.shopify_error,
        ix_error: t.ix_error,
        is_inactive: Number(t.is_inactive) === 1,
    };
}

export async function getImpersonationId(request: Request) {
    const cookie = request.headers.get("cookie");
    if (!cookie) return null;
    const match = cookie.match(/rioko_impersonate_id=([^;]+)/);
    return match ? match[1] : null;
}
