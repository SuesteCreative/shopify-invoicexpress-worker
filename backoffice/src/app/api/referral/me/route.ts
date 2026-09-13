import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { resolveAccountUser } from "@/lib/account";
import { ensureClientCode } from "@/lib/client-code";
import {
    newReferralSuffix, referralToken, referralLink,
    campaignOpen, CAMPAIGN_END, MAX_REWARDS, REWARD_MONTHS,
} from "@/lib/referral";

export const runtime = "edge";

/**
 * The merchant's own invite link, and what it has earned.
 *
 * The link is their customer number plus a suffix — one number per client, the
 * same one on their record and on ours — and the suffix is minted here, on the
 * first view, rather than for every account up front: most accounts never open
 * this, and a suffix nobody has is a write nobody needed. Once minted it is kept,
 * because it may already be in somebody's inbox.
 *
 * Everything is resolved through resolveAccountUser, so an invited seat sees the
 * ACCOUNT's link. Two colleagues must not be able to produce two links for one
 * company, or the same company appears twice in its own campaign.
 */
export async function GET(request: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const db = (getRequestContext().env as any).DB as D1Database;
        const accountId = await resolveAccountUser(request, userId);

        let row: any = await db.prepare(
            "SELECT client_code, referral_suffix FROM users WHERE id = ?"
        ).bind(accountId).first();

        const code = row?.client_code ?? await ensureClientCode(db, accountId);
        let suffix: string | null = row?.referral_suffix ?? null;
        if (code && !suffix) {
            const minted = newReferralSuffix();
            // Only fills a NULL, so two tabs racing cannot end with one of them
            // holding a suffix that was never stored.
            await db.prepare(
                "UPDATE users SET referral_suffix = ? WHERE id = ? AND referral_suffix IS NULL"
            ).bind(minted, accountId).run();
            row = await db.prepare("SELECT referral_suffix FROM users WHERE id = ?").bind(accountId).first();
            suffix = row?.referral_suffix ?? minted;
        }

        // The reward is months added to a running subscription, so whoever has
        // none cannot be paid. Said plainly on the card rather than discovered
        // after they have already sent the link to a friend.
        const live: any = await db.prepare(
            `SELECT 1 AS ok FROM subscriptions
              WHERE user_id = ? AND stripe_subscription_id IS NOT NULL
                AND status IN ('active','trialing') LIMIT 1`
        ).bind(accountId).first();

        const { results } = await db.prepare(`
            SELECT r.invitee_user_id, r.state, r.claimed_at, r.reward_until,
                   COALESCE(NULLIF(u.company_name,''), NULLIF(u.name,''), 'Conta convidada') AS label
              FROM referrals r
              LEFT JOIN users u ON u.id = r.invitee_user_id
             WHERE r.inviter_user_id = ?
             ORDER BY r.claimed_at DESC
        `).bind(accountId).all();

        const invites = (results ?? []) as any[];
        const rewarded = invites.filter((i) => i.state === "rewarded").length;

        // The other side: this account came in through somebody's link and has
        // not subscribed yet. Same predicate billing/checkout uses to put the
        // trial on the session, so the page never promises a trial the checkout
        // will not create.
        const open = campaignOpen();
        const invitedRow: any = await db.prepare(
            "SELECT 1 AS ok FROM referrals WHERE invitee_user_id = ? AND state = 'pending' LIMIT 1"
        ).bind(accountId).first();

        return NextResponse.json({
            code: code ?? null,
            token: code && suffix ? referralToken(code, suffix) : null,
            link: code && suffix ? referralLink(referralToken(code, suffix)) : null,
            campaign_end: CAMPAIGN_END,
            campaign_open: open,
            eligible: Boolean(live?.ok),
            invited_pending: Boolean(invitedRow?.ok) && open,
            trial_months: REWARD_MONTHS,
            reward_months: REWARD_MONTHS,
            max_rewards: MAX_REWARDS,
            rewarded,
            months_earned: rewarded * REWARD_MONTHS,
            invited: invites.length,
            invites: invites.map((i) => ({
                // The invitee's own name and state, and nothing else about them:
                // no email, no NIF, no volumes. The campaign terms say exactly
                // this much is shown, and this is the line that keeps that true.
                label: i.label,
                state: i.state,
                claimed_at: i.claimed_at,
                reward_until: i.reward_until,
            })),
        });
    } catch (error: any) {
        console.error("[referral/me] failed:", error?.message ?? error);
        return NextResponse.json({ error: "referral_failed" }, { status: 500 });
    }
}
