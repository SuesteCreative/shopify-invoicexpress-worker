import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { isAdmin, getImpersonationId } from "./admin";

/**
 * Account resolution — "whose data am I looking at?".
 *
 * Rioko keys everything it owns on the Clerk id of the person who signed up.
 * With extra users (migration 0039) that id is no longer the same thing as the
 * account: an invited member authenticates as themselves but works INSIDE the
 * owner's account. Every account-scoped route therefore resolves the account id
 * through here instead of using `auth().userId` directly.
 *
 * Precedence, highest first:
 *   1. admin impersonation cookie (only honoured for a real admin)
 *   2. an active membership → the owner's account
 *   3. the caller's own id
 *
 * Failing to patch a route is not a data leak: it falls back to the caller's own
 * (empty) account, so the worst case is a member seeing nothing.
 */

export type AccountAccess = "owner" | "admin" | "viewer";

export interface AccountContext {
    /** The authenticated Clerk id (never the account, when a member is calling). */
    authUserId: string;
    /** The account whose rows this request may read/write. */
    accountId: string;
    /** What this caller may do inside that account. */
    access: AccountAccess;
    /** True when a platform admin is impersonating someone. */
    impersonating: boolean;
}

export interface MembershipRow {
    id: string;
    account_id: string;
    email: string;
    member_user_id: string | null;
    role: string;
    status: string;
    invited_by: string | null;
    seat_invoice_id: string | null;
    seat_amount_cents: number | null;
    seat_paid_at: string | null;
    created_at: string;
    accepted_at: string | null;
}

export function getAccountDB(): D1Database | null {
    try {
        return ((getRequestContext().env as any)?.DB as D1Database) ?? null;
    } catch {
        return null;
    }
}

/** The membership this Clerk user holds in someone else's account, if any. */
export async function findMembershipFor(memberUserId: string): Promise<MembershipRow | null> {
    const db = getAccountDB();
    if (!db) return null;
    try {
        return await db
            .prepare("SELECT * FROM account_members WHERE member_user_id = ? AND status = 'active' ORDER BY accepted_at ASC LIMIT 1")
            .bind(memberUserId)
            .first<MembershipRow>();
    } catch {
        // Table not migrated yet — behave exactly as before extra users existed.
        return null;
    }
}

/** Full context for the current request. Returns null when unauthenticated. */
export async function getAccountContext(request: Request): Promise<AccountContext | null> {
    const { userId } = await auth();
    if (!userId) return null;

    if (await isAdmin(userId)) {
        const imp = await getImpersonationId(request);
        if (imp) return { authUserId: userId, accountId: imp, access: "owner", impersonating: true };
        return { authUserId: userId, accountId: userId, access: "owner", impersonating: false };
    }

    const membership = await findMembershipFor(userId);
    if (membership) {
        return {
            authUserId: userId,
            accountId: membership.account_id,
            access: membership.role === "admin" ? "admin" : "viewer",
            impersonating: false,
        };
    }

    return { authUserId: userId, accountId: userId, access: "owner", impersonating: false };
}

/** Thrown when a read-only member attempts a write. Routes surface it through
 *  their own catch; the middleware blocks most of these earlier. */
export class ReadOnlyMemberError extends Error {
    constructor() {
        super("read_only_member");
        this.name = "ReadOnlyMemberError";
    }
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The account id for a caller whose auth id the route already has. Drop-in
 * replacement for the `isAdmin(userId) + getImpersonationId(request)` block that
 * every account-scoped route used to inline.
 *
 * Also the enforcement point for read-only members: on a write request from a
 * viewer it throws instead of returning an account to write into.
 */
export async function resolveAccountUser(request: Request, authUserId: string): Promise<string> {
    if (await isAdmin(authUserId)) {
        const imp = await getImpersonationId(request);
        if (imp) return imp;
        return authUserId;
    }
    const membership = await findMembershipFor(authUserId);
    if (!membership) return authUserId;
    if (membership.role === "viewer" && !READ_METHODS.has(request.method.toUpperCase())) {
        throw new ReadOnlyMemberError();
    }
    return membership.account_id;
}

/** True when this caller may only read. Middleware blocks the writes; routes
 *  that build their own responses can ask directly. */
export async function isReadOnlyMember(authUserId: string): Promise<boolean> {
    if (await isAdmin(authUserId)) return false;
    const membership = await findMembershipFor(authUserId);
    return membership?.role === "viewer";
}

export interface SeatPool {
    /** Seats the account owns. Never decreases: removing someone frees the seat,
     *  it does not refund it. */
    paid: number;
    /** Seats in use right now — pending invites included, since an invite takes
     *  the seat the moment it is sent. The owner is not a seat. */
    occupied: number;
    /** Seats the account owns with nobody in them: invite into one for free. */
    free: number;
}

/** What the account owns versus what it is using. Buying a seat is its own
 *  action (POST /api/account/seats); inviting only fills one. */
export async function getSeatPool(accountId: string): Promise<SeatPool> {
    const db = getAccountDB();
    if (!db) return { paid: 0, occupied: 0, free: 0 };
    try {
        const owned: any = await db
            .prepare("SELECT COUNT(*) AS n FROM account_seats WHERE account_id = ?")
            .bind(accountId)
            .first();
        const used: any = await db
            .prepare("SELECT COUNT(*) AS n FROM account_members WHERE account_id = ? AND status IN ('pending','active')")
            .bind(accountId)
            .first();
        const paid = Number(owned?.n ?? 0);
        const occupied = Number(used?.n ?? 0);
        return { paid, occupied, free: Math.max(0, paid - occupied) };
    } catch {
        return { paid: 0, occupied: 0, free: 0 };
    }
}
