import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { isAdmin, isHiperadmin } from "@/lib/admin";
import { getStripe } from "@/lib/stripe";
import { ACCOUNT_LABEL_SQL } from "@/lib/labels";
import { rewardInviter } from "@/lib/referral-reward";
import { MAX_REWARDS, REWARD_MONTHS } from "@/lib/referral";

export const runtime = "edge";

const db = () => (getRequestContext().env as any).DB as D1Database;

/**
 * Who invited whom, and what it cost.
 *
 * The column worth reading is `invitee_paid`: a reward is granted the moment the
 * invitee's subscription exists, which is before any money has arrived. That is
 * a deliberate decision about the campaign, and this is where it stays visible —
 * a row rewarded months ago whose invitee never paid is the shape abuse takes.
 */
export async function GET() {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { results } = await db().prepare(`
        SELECT r.invitee_user_id, r.inviter_user_id, r.inviter_client_code, r.state,
               r.claimed_at, r.invitee_subscribed_at, r.reward_months, r.reward_until,
               r.rewarded_at, r.void_reason, r.note,
               ${ACCOUNT_LABEL_SQL("inv")} AS inviter_label,
               ${ACCOUNT_LABEL_SQL("ite")} AS invitee_label,
               ite.client_code AS invitee_client_code,
               EXISTS (SELECT 1 FROM billing_events b
                        WHERE b.user_id = r.invitee_user_id
                          AND b.type = 'invoice.paid'
                          AND COALESCE(b.amount_cents, 0) > 0) AS invitee_paid
          FROM referrals r
          LEFT JOIN users inv ON inv.id = r.inviter_user_id
          LEFT JOIN users ite ON ite.id = r.invitee_user_id
         ORDER BY r.claimed_at DESC
         LIMIT 200
    `).all();

    const rows = (results ?? []) as any[];
    return NextResponse.json({
        referrals: rows.map((r) => ({ ...r, invitee_paid: Boolean(r.invitee_paid) })),
        rewarded: rows.filter((r) => r.state === "rewarded").length,
        months_given: rows.reduce((n, r) => n + (r.reward_months ?? 0), 0),
        owed: rows.filter((r) => r.state === "subscribed").length,
        max_rewards: MAX_REWARDS,
        reward_months: REWARD_MONTHS,
        // Any admin reads this; only a hiperadmin may retry or void (POST). The
        // card used to offer both buttons to a superadmin, who got a 401.
        can_act: await isHiperadmin(userId),
    });
}

/**
 * Pay a reward that got stuck.
 *
 * The webhook already tries when the invitee's subscription appears. What lands
 * here is what it refused at the time and a human has since decided about — the
 * inviter had no live subscription then and does now, most often. Idempotent:
 * the row has to be back in `pending` for anything to happen, and putting it
 * there is itself an admin act.
 */
export async function POST(request: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId || !(await isHiperadmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        const body = await request.json().catch(() => ({})) as {
            invitee_user_id?: string; action?: "retry" | "void";
        };
        const invitee = String(body.invitee_user_id ?? "").trim();
        if (!invitee) return NextResponse.json({ error: "Missing invitee_user_id" }, { status: 400 });

        if (body.action === "void") {
            await db().prepare(
                "UPDATE referrals SET state = 'void', void_reason = 'admin' WHERE invitee_user_id = ? AND rewarded_at IS NULL"
            ).bind(invitee).run();
            console.warn(`[admin/referrals] voided ${invitee} by ${userId}`);
            return NextResponse.json({ ok: true, voided: true });
        }

        const row: any = await db().prepare(
            "SELECT state, invitee_subscription_id FROM referrals WHERE invitee_user_id = ?"
        ).bind(invitee).first();
        if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
        if (row.state === "rewarded") return NextResponse.json({ ok: true, already: true });
        if (!row.invitee_subscription_id) {
            return NextResponse.json({ error: "o convidado ainda não subscreveu" }, { status: 400 });
        }

        // Back to pending so the one function that pays a reward is the one that
        // pays this one too — there is no second code path for admins.
        await db().prepare(
            "UPDATE referrals SET state = 'pending', note = NULL, void_reason = NULL WHERE invitee_user_id = ?"
        ).bind(invitee).run();

        const result = await rewardInviter(db(), getStripe(), invitee, row.invitee_subscription_id);
        console.warn(`[admin/referrals] retry ${invitee} by ${userId}: ${result.rewarded ? "rewarded" : result.reason}`);
        return NextResponse.json(result);
    } catch (error: any) {
        console.error("[admin/referrals] failed:", error?.message ?? error);
        return NextResponse.json({ error: "referral_action_failed" }, { status: 500 });
    }
}
