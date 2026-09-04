import { NextRequest, NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { getAccountContext, getAccountDB, getSeatPool, findReusableSeat } from "@/lib/account";
import { accountLabel } from "@/lib/labels";
import { resolveSeatPrice, chargeSeat } from "@/lib/seats";

export const runtime = "edge";

const VALID_ROLES = new Set(["admin", "viewer"]);

/** Anyone in the account may list its people; only owner/admin may change them. */
async function requireManager(req: NextRequest) {
    const ctx = await getAccountContext(req);
    if (!ctx) return { error: "Unauthorized", status: 401 as const };
    if (ctx.access === "viewer") return { error: "read_only", status: 403 as const };
    return { ctx };
}

/** Whether this account may buy seats: a live Stripe subscription with a card on
 *  file, or a platform admin (exempt — seats are free for them). */
async function seatEligibility(accountId: string) {
    const db = getAccountDB();
    if (!db) return { ok: false as const, reason: "no_db", customerId: null as string | null, exempt: false };

    const user: any = await db.prepare("SELECT role FROM users WHERE id = ?").bind(accountId).first();
    if (user?.role === "superadmin" || user?.role === "hiperadmin") {
        return { ok: true as const, reason: "exempt", customerId: null, exempt: true };
    }

    const sub: any = await db
        .prepare("SELECT status, stripe_customer_id, stripe_subscription_id FROM subscriptions WHERE user_id = ?")
        .bind(accountId)
        .first();

    const live = !!sub?.stripe_subscription_id && ["active", "trialing"].includes(String(sub?.status));
    if (!live || !sub?.stripe_customer_id) {
        return { ok: false as const, reason: "subscription_required", customerId: sub?.stripe_customer_id ?? null, exempt: false };
    }
    return { ok: true as const, reason: "subscribed", customerId: String(sub.stripe_customer_id), exempt: false };
}

/** GET /api/account/members — the account's people and what a seat costs. */
export async function GET(req: NextRequest) {
    try {
        const ctx = await getAccountContext(req);
        if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const db = getAccountDB();
        if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

        const owner: any = await db
            .prepare("SELECT id, name, email, company_name, admin_label FROM users WHERE id = ?")
            .bind(ctx.accountId)
            .first();

        let members: any[] = [];
        try {
            const rows = await db
                .prepare(`SELECT id, email, member_user_id, role, status, seat_invoice_id, seat_amount_cents,
                                 seat_paid_at, seat_reused_from, created_at, accepted_at
                          FROM account_members
                          WHERE account_id = ? AND status <> 'revoked'
                          ORDER BY created_at ASC`)
                .bind(ctx.accountId)
                .all();
            members = (rows.results as any[]) ?? [];
        } catch {
            // Migration 0039 not applied yet: show the owner alone rather than 500.
            members = [];
        }

        let seat_price: { amount_cents: number; currency: string } | null = null;
        try {
            const price = await resolveSeatPrice();
            seat_price = { amount_cents: price.unit_amount, currency: price.currency };
        } catch { /* the page falls back to its static label */ }

        const eligibility = await seatEligibility(ctx.accountId);
        const seats = await getSeatPool(ctx.accountId);

        return NextResponse.json({
            account_id: ctx.accountId,
            access: ctx.access,
            owner: {
                id: owner?.id ?? ctx.accountId,
                email: owner?.email ?? null,
                label: accountLabel(owner, ctx.accountId),
            },
            members,
            seat_price,
            seats,
            // A free seat is one the account already paid for and nobody is using.
            next_invite_free: seats.free > 0 || eligibility.exempt,
            can_invite: eligibility.ok,
            invite_block_reason: eligibility.ok ? null : eligibility.reason,
        });
    } catch (e: any) {
        console.error("[account/members] GET", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

/** POST /api/account/members — invite someone. The seat is charged here, when the
 *  invite is sent: no charge, no invite. */
export async function POST(req: NextRequest) {
    try {
        const guard = await requireManager(req);
        if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });
        const { ctx } = guard;

        const body = (await req.json().catch(() => ({}))) as { email?: string; role?: string };
        const email = (body.email ?? "").trim().toLowerCase();
        const role = VALID_ROLES.has(String(body.role)) ? String(body.role) : "viewer";
        if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
            return NextResponse.json({ error: "invalid_email" }, { status: 400 });
        }

        const db = getAccountDB();
        if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

        const owner: any = await db.prepare("SELECT email FROM users WHERE id = ?").bind(ctx.accountId).first();
        if (owner?.email && String(owner.email).toLowerCase() === email) {
            return NextResponse.json({ error: "already_owner" }, { status: 400 });
        }

        const existing: any = await db
            .prepare("SELECT id FROM account_members WHERE account_id = ? AND email = ? AND status <> 'revoked'")
            .bind(ctx.accountId, email)
            .first();
        if (existing) return NextResponse.json({ error: "already_member" }, { status: 409 });

        // A seat freed by a removal is reused for free: only a new seat is billed.
        const pool = await getSeatPool(ctx.accountId);
        const reusedSeat = pool.free > 0 ? await findReusableSeat(ctx.accountId) : null;
        const needsPurchase = pool.free === 0;

        const eligibility = await seatEligibility(ctx.accountId);
        // Buying a seat needs a live subscription; filling a seat already paid for
        // does not (an account that lapses keeps the room it bought).
        if (needsPurchase && !eligibility.ok) {
            return NextResponse.json({ error: eligibility.reason }, { status: 402 });
        }

        // Reserve the seat first, so a charge can never be collected without a row
        // to point at. A failed charge deletes the row again.
        const memberId = crypto.randomUUID();
        await db
            .prepare(`INSERT INTO account_members (id, account_id, email, role, status, invited_by, seat_reused_from)
                      VALUES (?, ?, ?, ?, 'pending', ?, ?)`)
            .bind(memberId, ctx.accountId, email, role, ctx.authUserId, reusedSeat)
            .run();

        let seat: { invoice_id: string; amount_cents: number } | null = null;
        if (needsPurchase && !eligibility.exempt && eligibility.customerId) {
            try {
                const charged = await chargeSeat({
                    customerId: eligibility.customerId,
                    accountId: ctx.accountId,
                    memberEmail: email,
                    memberRowId: memberId,
                });
                seat = { invoice_id: charged.invoice_id, amount_cents: charged.amount_cents };
            } catch (e: any) {
                await db.prepare("DELETE FROM account_members WHERE id = ?").bind(memberId).run();
                return NextResponse.json({ error: "payment_failed", detail: e?.message ?? String(e) }, { status: 402 });
            }
            await db
                .prepare("UPDATE account_members SET seat_invoice_id = ?, seat_amount_cents = ?, seat_paid_at = CURRENT_TIMESTAMP WHERE id = ?")
                .bind(seat.invoice_id, seat.amount_cents, memberId)
                .run();
        }

        // Someone who already has a Rioko login joins immediately; everyone else
        // gets a Clerk invitation email carrying the membership in its metadata.
        const clerk = await clerkClient();
        let invitationId: string | null = null;
        let joinedNow = false;

        let existingClerkId: string | null = null;
        try {
            const found = await clerk.users.getUserList({ emailAddress: [email], limit: 1 });
            existingClerkId = found.data?.[0]?.id ?? null;
        } catch { /* fall through to the invitation path */ }

        if (existingClerkId) {
            await db
                .prepare("UPDATE account_members SET member_user_id = ?, status = 'active', accepted_at = CURRENT_TIMESTAMP WHERE id = ?")
                .bind(existingClerkId, memberId)
                .run();
            joinedNow = true;
            try {
                await clerk.users.updateUserMetadata(existingClerkId, {
                    publicMetadata: { rioko_account_id: ctx.accountId, rioko_role: role },
                });
            } catch (e: any) {
                console.warn("[account/members] metadata stamp failed:", e?.message ?? e);
            }
        } else {
            try {
                const origin = new URL(req.url).origin;
                // Send them to the locale the inviter is using: /sign-up alone
                // would bounce through the intl middleware before Clerk reads the
                // invitation ticket off the query string.
                const locale = /\/(pt|en)(\/|$)/.exec(req.headers.get("referer") ?? "")?.[1] ?? "pt";
                const invitation = await clerk.invitations.createInvitation({
                    emailAddress: email,
                    redirectUrl: `${origin}/${locale}/sign-up`,
                    publicMetadata: { rioko_account_id: ctx.accountId, rioko_role: role },
                    ignoreExisting: true,
                });
                invitationId = invitation.id;
                await db.prepare("UPDATE account_members SET clerk_invitation_id = ? WHERE id = ?").bind(invitationId, memberId).run();
            } catch (e: any) {
                // The seat is paid and the row exists: the person can still sign up
                // by themselves and the Clerk webhook matches them by email.
                console.warn("[account/members] invitation failed:", e?.message ?? e);
            }
        }

        return NextResponse.json({
            ok: true,
            member: { id: memberId, email, role, status: joinedNow ? "active" : "pending" },
            seat_charged: !!seat,
            seat_reused: !needsPurchase,
            seat_invoice_id: seat?.invoice_id ?? null,
            invitation_id: invitationId,
            joined_now: joinedNow,
        });
    } catch (e: any) {
        console.error("[account/members] POST", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
