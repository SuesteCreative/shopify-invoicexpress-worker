import { MAX_REWARDS, REWARD_MONTHS } from "./referral";

/**
 * Paying both sides of a referral.
 *
 * The invitee's two months are not here: they are `trial_period_days` on their
 * Checkout, Stripe runs the clock and charges the card on its own at the end.
 *
 * This file is the OTHER side — two months added to a subscription that is
 * already running — and the instrument is `trial_end`, pushed out. Verified
 * against docs.stripe.com/api/subscriptions/update:
 *
 *   "If set, trial_end will override the default trial period ... The
 *    billing_cycle_anchor will be updated to the trial_end value."
 *
 * That sentence is the whole feature. Moving the anchor is what makes the next
 * charge happen two months later, and it is what makes the ANNUAL case behave as
 * promised: the anchor lands two months out, so the following year starts from
 * there instead of from the original date. The two alternatives are both wrong
 * for annual — a 100%-off coupon would give a free YEAR, and a customer balance
 * credit of two monthly amounts is 1/6 of an annual invoice, not two months of
 * calendar.
 *
 * `proration_behavior: "none"` is load-bearing, not hygiene. The same page lists
 * the billing cycle changing "(e.g. ... or starting a trial)" as a proration
 * event, so without it Stripe writes adjustment lines into a reward that was
 * meant to be clean. With it, the period already paid for simply runs out and
 * the free months follow: nothing is credited, nothing is charged.
 */

export interface RewardResult {
    rewarded: boolean;
    reason?: string;
    inviter_user_id?: string | null;
    subscription_id?: string | null;
    reward_until?: string | null;
}

/**
 * Add whole months to an instant, clamping to the end of the month.
 *
 * Date.setMonth overflows — 31 December plus two months is 3 March, not 28
 * February — and an overflow here is a free month somebody did not earn, or one
 * they did and did not get.
 */
export function addMonths(iso: string, months: number): string {
    const d = new Date(iso);
    const day = d.getUTCDate();
    const target = new Date(Date.UTC(
        d.getUTCFullYear(), d.getUTCMonth() + months, 1,
        d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds(),
    ));
    const lastDayOfTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(day, lastDayOfTarget));
    return target.toISOString();
}

/**
 * Where the two months are counted from, in seconds since the epoch.
 *
 * The end of the period the subscription is currently in — and while it is
 * already inside a reward, that IS its `trial_end`, which is what makes the
 * second and third rewards stack by the same arithmetic as the first.
 *
 * `current_period_end` moved onto the subscription ITEM in later API versions,
 * so both places are read. Returns null rather than guessing: a reward with no
 * base date must be parked for a human, never approximated.
 */
export function periodEndOf(sub: any): number | null {
    const candidates = [
        typeof sub?.trial_end === "number" ? sub.trial_end : null,
        typeof sub?.current_period_end === "number" ? sub.current_period_end : null,
        typeof sub?.items?.data?.[0]?.current_period_end === "number"
            ? sub.items.data[0].current_period_end
            : null,
    ].filter((n): n is number => typeof n === "number" && n > 0);
    if (!candidates.length) return null;
    return Math.max(...candidates);
}

/** The subscription the reward lands on: the account's principal one. */
const INVITER_SUBSCRIPTION_SQL = `
  SELECT connection_key, stripe_subscription_id, status, reward_until
    FROM subscriptions
   WHERE user_id = ?
     AND stripe_subscription_id IS NOT NULL
     AND status IN ('active','trialing')
   ORDER BY created_at ASC
   LIMIT 1
`;

/**
 * The invitee has just subscribed. Pay whoever invited them.
 *
 * Called from `customer.subscription.created` in the Stripe webhook. Claiming
 * the row is a conditional UPDATE, so a re-delivery of the same event finds
 * nothing left to claim and this costs one indexed lookup for everybody else.
 */
export async function rewardInviter(
    db: D1Database,
    stripe: any,
    inviteeUserId: string,
    inviteeSubscriptionId: string,
    now = new Date(),
): Promise<RewardResult> {
    if (!inviteeUserId || !inviteeSubscriptionId) return { rewarded: false, reason: "missing_input" };

    const claimed = await db.prepare(
        `UPDATE referrals
            SET state = 'subscribed', invitee_subscription_id = ?, invitee_subscribed_at = ?
          WHERE invitee_user_id = ? AND state = 'pending'`
    ).bind(inviteeSubscriptionId, now.toISOString(), inviteeUserId).run();
    if (((claimed as any)?.meta?.changes ?? 0) === 0) return { rewarded: false, reason: "not_pending" };

    const row: any = await db.prepare(
        "SELECT inviter_user_id, inviter_client_code FROM referrals WHERE invitee_user_id = ?"
    ).bind(inviteeUserId).first();
    const inviter = row?.inviter_user_id as string | undefined;
    if (!inviter) return { rewarded: false, reason: "no_inviter" };

    const park = async (reason: string, voidIt: boolean): Promise<RewardResult> => {
        await db.prepare(
            voidIt
                ? "UPDATE referrals SET state = 'void', void_reason = ? WHERE invitee_user_id = ? AND rewarded_at IS NULL"
                : "UPDATE referrals SET note = ? WHERE invitee_user_id = ? AND rewarded_at IS NULL"
        ).bind(reason, inviteeUserId).run();
        return { rewarded: false, reason, inviter_user_id: inviter };
    };

    // The ceiling the copy promises: three rewards, six months, and the fourth
    // referral is recorded but not paid.
    const paid: any = await db.prepare(
        "SELECT COUNT(*) AS n FROM referrals WHERE inviter_user_id = ? AND state = 'rewarded'"
    ).bind(inviter).first();
    if ((paid?.n ?? 0) >= MAX_REWARDS) return park("cap_reached", true);

    // Self-dealing costs one card and buys two months. By now both sides have
    // been through a checkout, which is where a fiscal number gets collected.
    if (await sharesFiscalId(db, inviter, inviteeUserId)) return park("same_fiscal_id", true);

    // The reward is months added to a subscription, so there has to be one.
    const target: any = await db.prepare(INVITER_SUBSCRIPTION_SQL).bind(inviter).first();
    if (!target?.stripe_subscription_id) return park("inviter_no_live_subscription", false);

    try {
        const sub = await stripe.subscriptions.retrieve(target.stripe_subscription_id);
        if (["canceled", "unpaid", "incomplete_expired"].includes(sub?.status)) {
            return park("inviter_subscription_dead", false);
        }
        const base = periodEndOf(sub);
        if (!base) return park("no_period_end", false);

        const rewardUntil = addMonths(new Date(base * 1000).toISOString(), REWARD_MONTHS);

        await stripe.subscriptions.update(
            target.stripe_subscription_id,
            {
                trial_end: Math.floor(new Date(rewardUntil).getTime() / 1000),
                proration_behavior: "none",
                metadata: { ...(sub?.metadata ?? {}), rioko_reward_until: rewardUntil },
            },
            { idempotencyKey: `rioko-reward-${inviteeUserId}` },
        );

        await db.prepare(
            `UPDATE referrals
                SET state = 'rewarded', reward_months = ?, reward_until = ?, rewarded_at = ?, note = NULL
              WHERE invitee_user_id = ? AND rewarded_at IS NULL`
        ).bind(REWARD_MONTHS, rewardUntil, now.toISOString(), inviteeUserId).run();

        // Why the subscription is `trialing`, for the panel that would otherwise
        // call a paying client a trial.
        await db.prepare(
            "UPDATE subscriptions SET reward_until = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND connection_key = ?"
        ).bind(rewardUntil, inviter, target.connection_key).run();

        return {
            rewarded: true,
            inviter_user_id: inviter,
            subscription_id: target.stripe_subscription_id,
            reward_until: rewardUntil,
        };
    } catch (e: any) {
        return park(String(e?.message ?? e).slice(0, 200), false);
    }
}

/** Same fiscal number on both sides of a referral is one company, twice. */
export async function sharesFiscalId(
    db: D1Database, inviterUserId: string, inviteeUserId: string,
): Promise<boolean> {
    const nifOf = async (userId: string): Promise<string | null> => {
        const s: any = await db.prepare(
            `SELECT nif FROM subscriptions WHERE user_id = ? AND nif IS NOT NULL AND TRIM(nif) <> ''
              ORDER BY updated_at DESC LIMIT 1`
        ).bind(userId).first();
        if (s?.nif) return String(s.nif).replace(/\D/g, "");
        const u: any = await db.prepare(
            "SELECT nif FROM users WHERE id = ? AND nif IS NOT NULL AND TRIM(nif) <> ''"
        ).bind(userId).first();
        return u?.nif ? String(u.nif).replace(/\D/g, "") : null;
    };
    const [a, b] = await Promise.all([nifOf(inviterUserId), nifOf(inviteeUserId)]);
    return Boolean(a && b && a === b);
}
