import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { isAdmin, isHiperadmin } from "@/lib/admin";
import { getStripe } from "@/lib/stripe";
import { ACCOUNT_LABEL_SQL } from "@/lib/labels";
import { drainPendingReferralCredits } from "@/lib/referral-credit";

export const runtime = "edge";

const db = () => (getRequestContext().env as any).DB as D1Database;

/** Who invited whom, what state it is in, and what it cost us. */
export async function GET() {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { results } = await db().prepare(`
        SELECT r.invitee_user_id, r.inviter_user_id, r.code, r.state,
               r.credit_cents, r.claimed_at, r.invitee_paid_at, r.credited_at, r.note,
               ${ACCOUNT_LABEL_SQL("inv")} AS inviter_label,
               ${ACCOUNT_LABEL_SQL("ite")} AS invitee_label
          FROM referrals r
          LEFT JOIN users inv ON inv.id = r.inviter_user_id
          LEFT JOIN users ite ON ite.id = r.invitee_user_id
         ORDER BY r.claimed_at DESC
         LIMIT 200
    `).all();

    const rows = (results ?? []) as any[];
    return NextResponse.json({
        referrals: rows,
        total_credited_cents: rows.reduce((s, r) => s + (r.credit_cents ?? 0), 0),
        owed: rows.filter((r) => r.state === "paid").length,
    });
}

/**
 * Pay an inviter whose credit is stuck.
 *
 * The webhook already tries this twice, on the invitee's payment and on the
 * inviter's own checkout. What lands here is the third case: something Stripe
 * refused at the time, or an inviter who never came back. Idempotent, so
 * pressing it twice costs nothing.
 */
export async function POST(request: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId || !(await isHiperadmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        const body = await request.json().catch(() => ({})) as { inviter_user_id?: string };
        const inviter = String(body.inviter_user_id ?? "").trim();
        if (!inviter) return NextResponse.json({ error: "Missing inviter_user_id" }, { status: 400 });

        const result = await drainPendingReferralCredits(db(), getStripe(), inviter);
        console.warn(`[admin/referrals] drained ${result.credited} for ${inviter} by ${userId}`);
        return NextResponse.json(result);
    } catch (error: any) {
        console.error("[admin/referrals] failed:", error?.message ?? error);
        return NextResponse.json({ error: "drain_failed" }, { status: 500 });
    }
}
