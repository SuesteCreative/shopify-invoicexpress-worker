import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { resolveAccountUser } from "@/lib/account";
import { primaryConnectionKey } from "@/lib/stripe";
import { claimRefusal, inviteeTrialEnd, REFUSAL_PT, isValidReferralCode } from "@/lib/referral";

export const runtime = "edge";

/**
 * Claim a referral, once, and grant the invitee their free month.
 *
 * The token is the authorisation, not an admin right — same as the onboarding
 * invite. Everything it can do is give somebody thirty days of a product they
 * would otherwise pay 9,23 € for, and the account it credits has to pay a real
 * invoice before anybody is owed anything.
 *
 * Already claimed answers ok, not an error. The hook behind this replays on
 * every load until it succeeds, so a reload has to be quiet.
 */
export async function POST(request: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const body = await request.json().catch(() => ({})) as { token?: string };
        const code = String(body.token ?? "").trim().toLowerCase();
        if (!isValidReferralCode(code)) {
            return NextResponse.json({ error: REFUSAL_PT.invalid }, { status: 400 });
        }

        const db = (getRequestContext().env as any).DB as D1Database;
        const invitee = await resolveAccountUser(request, userId);

        const existing: any = await db.prepare(
            "SELECT inviter_user_id, state FROM referrals WHERE invitee_user_id = ?"
        ).bind(invitee).first();
        if (existing) return NextResponse.json({ ok: true, already: true });

        const owner: any = await db.prepare(
            "SELECT user_id FROM referral_codes WHERE code = ?"
        ).bind(code).first();

        const me: any = await db.prepare("SELECT created_at FROM users WHERE id = ?").bind(invitee).first();

        const refusal = claimRefusal({
            code,
            inviterUserId: owner?.user_id ?? null,
            inviteeUserId: invitee,
            inviteeCreatedAt: me?.created_at ?? null,
            now: new Date(),
        });
        if (refusal) {
            return NextResponse.json({ error: REFUSAL_PT[refusal], refusal }, { status: 400 });
        }

        // OR IGNORE because two tabs can arrive at once; the read-back below is
        // what decides what actually happened.
        await db.prepare(
            `INSERT OR IGNORE INTO referrals (invitee_user_id, code, inviter_user_id, state)
             VALUES (?, ?, ?, 'pending')`
        ).bind(invitee, code, owner.user_id).run();

        const stored: any = await db.prepare(
            "SELECT inviter_user_id FROM referrals WHERE invitee_user_id = ?"
        ).bind(invitee).first();
        if (!stored) return NextResponse.json({ error: REFUSAL_PT.invalid }, { status: 400 });

        // The free month. Not a Stripe coupon and not a Stripe trial: early_bird
        // plus a trial_end is what the gate already reads, and it is the only
        // version of this that is honestly "sem cartão".
        const connectionKey = await primaryConnectionKey(db, invitee);
        const trialEnd = inviteeTrialEnd(new Date());
        await db.prepare(`
            INSERT INTO subscriptions (user_id, connection_key, status, early_bird, trial_end, updated_at)
            VALUES (?, ?, 'trialing', 1, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, connection_key) DO UPDATE SET
              early_bird = 1,
              trial_end  = excluded.trial_end,
              updated_at = CURRENT_TIMESTAMP
            WHERE subscriptions.stripe_subscription_id IS NULL
              AND subscriptions.status <> 'active'
              -- Never shorten a grace somebody already has. An admin-set
              -- early-bird date is a decision, and this must not overwrite it
              -- with a nearer one.
              AND (subscriptions.trial_end IS NULL
                   OR datetime(subscriptions.trial_end) < datetime(excluded.trial_end))
        `).bind(invitee, connectionKey, trialEnd).run();

        console.warn(`[referral] ${invitee} claimed ${code} from ${stored.inviter_user_id}`);
        return NextResponse.json({ ok: true, trial_end: trialEnd });
    } catch (error: any) {
        console.error("[referral/claim] failed:", error?.message ?? error);
        return NextResponse.json({ error: "claim_failed" }, { status: 500 });
    }
}
