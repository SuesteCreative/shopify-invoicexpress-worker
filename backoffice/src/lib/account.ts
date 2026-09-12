import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { isAdmin, getImpersonationId } from "./admin";
// The pool arithmetic lives with the prices because that is what it is — how
// many seats the plan includes — and because this module cannot be imported
// outside a request, which makes anything defined here untestable.
import { seatPoolOf, type SeatPool } from "./price-catalogue";

export { INCLUDED_SEATS, seatPoolOf, type SeatPool } from "./price-catalogue";

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
    // 0039's per-invite seat columns are gone from here: nothing has written
    // them since seats became a pool (0040), and reading a column that is
    // always NULL is how the admin panel came to call every member free.
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

/**
 * What the account can fill versus what it is using. Unlocking buys capacity
 * (POST /api/account/seats); inviting only fills it.
 *
 * A read that fails throws. It used to answer "one free seat, nothing bought",
 * which is the most expensive possible guess: a D1 hiccup handed every account
 * a seat it had not paid for AND hid the ones it had.
 */
export async function getSeatPool(accountId: string): Promise<SeatPool> {
    const db = getAccountDB();
    if (!db) throw new Error("Database binding missing");
    const owned: any = await db
        .prepare("SELECT COUNT(*) AS n FROM account_seats WHERE account_id = ?")
        .bind(accountId)
        .first();
    const used: any = await db
        .prepare("SELECT COUNT(*) AS n FROM account_members WHERE account_id = ? AND status IN ('pending','active')")
        .bind(accountId)
        .first();
    return seatPoolOf(Number(owned?.n ?? 0), Number(used?.n ?? 0));
}

export interface SeatEligibility {
    ok: boolean;
    reason: "no_db" | "subscription_required" | "subscribed" | "exempt";
    /** The Stripe customer to bill, from the subscription that is actually
     *  live — never whichever row the database happened to return first. */
    customerId: string | null;
    /** Platform admins are not charged for seats; the seat is granted outright. */
    exempt: boolean;
}

/**
 * Whether this account may take another seat, and who pays for it.
 *
 * Shared by the page that offers the button and the route that acts on it. The
 * route used to check nothing at all — `can_unlock` only greyed a button out,
 * so anyone who could POST could buy a seat with no subscription — and it
 * looked the customer up with an unfiltered `LEFT JOIN subscriptions`, which on
 * an account with several rows (one per connection, 0044) returns an arbitrary
 * one: a cancelled connection's customer, or none, in which case Checkout was
 * told to mint a SECOND Stripe customer for the same account.
 */
export async function seatEligibility(accountId: string): Promise<SeatEligibility> {
    const db = getAccountDB();
    if (!db) return { ok: false, reason: "no_db", customerId: null, exempt: false };

    const user: any = await db.prepare("SELECT role FROM users WHERE id = ?").bind(accountId).first();
    if (user?.role === "superadmin" || user?.role === "hiperadmin") {
        return { ok: true, reason: "exempt", customerId: null, exempt: true };
    }

    // Seats are an account-level add-on, so ANY live subscription on the
    // account pays for them — not specifically the one of some connection.
    const sub: any = await db
        .prepare(`SELECT status, stripe_customer_id, stripe_subscription_id
                    FROM subscriptions
                   WHERE user_id = ? AND stripe_subscription_id IS NOT NULL
                     AND status IN ('active','trialing')
                   ORDER BY created_at ASC LIMIT 1`)
        .bind(accountId)
        .first();

    const live = !!sub?.stripe_subscription_id && ["active", "trialing"].includes(String(sub?.status));
    if (!live || !sub?.stripe_customer_id) {
        return { ok: false, reason: "subscription_required", customerId: sub?.stripe_customer_id ?? null, exempt: false };
    }
    return { ok: true, reason: "subscribed", customerId: String(sub.stripe_customer_id), exempt: false };
}
