import { CAMPAIGN_END, MAX_REWARDS, REWARD_MONTHS } from "./referral";

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
            SET state = 'subscribed', invitee_subscription_id = ?, invitee_subscribed_at = COALESCE(invitee_subscribed_at, ?)
          WHERE invitee_user_id = ? AND state = 'pending'`
    ).bind(inviteeSubscriptionId, now.toISOString(), inviteeUserId).run();
    if (((claimed as any)?.meta?.changes ?? 0) === 0) return { rewarded: false, reason: "not_pending" };

    const row: any = await db.prepare(
        "SELECT inviter_user_id, inviter_client_code, invitee_subscribed_at FROM referrals WHERE invitee_user_id = ?"
    ).bind(inviteeUserId).first();
    const inviter = row?.inviter_user_id as string | undefined;
    if (!inviter) return { rewarded: false, reason: "no_inviter" };

    // Set once the fiscal check has run. A parking note would otherwise overwrite
    // the only record that the check ran without the Checkout's NIF.
    let lookupNote: string | undefined;
    const park = async (reason: string, voidIt: boolean): Promise<RewardResult> => {
        await db.prepare(
            voidIt
                ? "UPDATE referrals SET state = 'void', void_reason = ? WHERE invitee_user_id = ? AND rewarded_at IS NULL"
                : "UPDATE referrals SET note = ? WHERE invitee_user_id = ? AND rewarded_at IS NULL"
        ).bind(!voidIt && lookupNote ? `${reason}; ${lookupNote}` : reason, inviteeUserId).run();
        return { rewarded: false, reason, inviter_user_id: inviter };
    };

    // Clause 2: the invitee's subscription has to be created inside the
    // campaign. Read off the row, not off `now`, so an admin retry in November of
    // a subscription created in October still counts, and a subscription created
    // in March does not.
    const subscribedOn = String(row?.invitee_subscribed_at ?? now.toISOString()).slice(0, 10);
    if (subscribedOn > CAMPAIGN_END) return park("after_campaign", true);

    // The ceiling the copy promises: three rewards, six months, and the fourth
    // referral is recorded but not paid.
    // ponytail: count-then-update, not atomic. Two invitee subscriptions for the
    // same inviter landing in the same second can both read 2 and both pay, so a
    // fourth reward is possible. Upgrade path if it ever happens: fold the count
    // into the final `SET state = 'rewarded'` as a guarded conditional UPDATE and
    // reserve the slot before calling Stripe.
    const paid: any = await db.prepare(
        "SELECT COUNT(*) AS n FROM referrals WHERE inviter_user_id = ? AND state = 'rewarded'"
    ).bind(inviter).first();
    if ((paid?.n ?? 0) >= MAX_REWARDS) return park("cap_reached", true);

    // Self-dealing costs one card and buys two months. By now both sides have
    // been through a checkout, which is where a fiscal number gets collected.
    const fiscal = await sharesFiscalId(db, stripe, inviter, inviteeUserId, inviteeSubscriptionId);
    if (fiscal.same) return park("same_fiscal_id", true);
    lookupNote = fiscal.note;

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

        // Stripe ends a subscription at cancel_at whatever trial_end says. On one
        // already scheduled to stop — a legacy sunset, a client leaving — a pushed
        // trial_end is two months recorded, shown on their card, and never
        // delivered. Parked for a human rather than promised.
        if (sub?.cancel_at || sub?.cancel_at_period_end) return park("inviter_subscription_ending", false);

        const rewardUntil = addMonths(new Date(base * 1000).toISOString(), REWARD_MONTHS);
        const trialEnd = Math.floor(new Date(rewardUntil).getTime() / 1000);

        // The target date is part of the key. Stripe refuses a reused key with
        // different parameters for 24 hours, so a key of the invitee alone turned
        // an admin retry aimed at a new date (the period renewed while the reward
        // was parked) into an idempotency error instead of a reward.
        // ponytail: the key only dedups a retry aimed at the SAME date. A push
        // that landed in Stripe but never reached D1 moves the base, so a retry
        // would push again. Upgrade path: stamp the invitee id on the
        // subscription metadata and skip the update when it is already there.
        await stripe.subscriptions.update(
            target.stripe_subscription_id,
            {
                trial_end: trialEnd,
                proration_behavior: "none",
                metadata: { ...(sub?.metadata ?? {}), rioko_reward_until: rewardUntil },
            },
            { idempotencyKey: `rioko-reward-${inviteeUserId}-${trialEnd}` },
        );

        // Clears a parking note from an earlier attempt, but keeps the one that
        // says the fiscal check ran without the Checkout's NIF.
        await db.prepare(
            `UPDATE referrals
                SET state = 'rewarded', reward_months = ?, reward_until = ?, rewarded_at = ?, note = ?
              WHERE invitee_user_id = ? AND rewarded_at IS NULL`
        ).bind(REWARD_MONTHS, rewardUntil, now.toISOString(), fiscal.note ?? null, inviteeUserId).run();

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

/**
 * Same fiscal number on both sides of a referral is one company, twice.
 *
 * The invitee's side is usually NOT in the database yet. This runs on
 * `customer.subscription.created`, and the NIF typed into the Checkout is only
 * stored by `checkout.session.completed`, which Stripe does not promise to send
 * first. So when the invitee has no stored number, it is read off the Checkout
 * Session that created their subscription.
 *
 * A failed lookup does not block the reward: the months are owed unless the
 * numbers are shown to match. It comes back as a `note` for the row instead, so
 * whoever reads the panel knows the check ran on stored data only.
 */
export async function sharesFiscalId(
    db: D1Database, stripe: any, inviterUserId: string, inviteeUserId: string, inviteeSubscriptionId: string,
): Promise<{ same: boolean; note?: string }> {
    const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "") || null;
    const nifOf = async (userId: string): Promise<string | null> => {
        const s: any = await db.prepare(
            `SELECT nif FROM subscriptions WHERE user_id = ? AND nif IS NOT NULL AND TRIM(nif) <> ''
              ORDER BY updated_at DESC LIMIT 1`
        ).bind(userId).first();
        if (s?.nif) return digits(s.nif);
        const u: any = await db.prepare(
            "SELECT nif FROM users WHERE id = ? AND nif IS NOT NULL AND TRIM(nif) <> ''"
        ).bind(userId).first();
        return digits(u?.nif);
    };
    const [a, stored] = await Promise.all([nifOf(inviterUserId), nifOf(inviteeUserId)]);
    // Nothing to compare against: not worth a Stripe call.
    if (!a) return { same: false };

    let b = stored;
    let note: string | undefined;
    if (!b) {
        try {
            const sessions = await stripe.checkout.sessions.list({ subscription: inviteeSubscriptionId, limit: 1 });
            const field = sessions?.data?.[0]?.custom_fields?.find((f: any) => f?.key === "nif");
            b = digits(field?.numeric?.value);
        } catch (e: any) {
            note = `fiscal_id_lookup_failed: ${String(e?.message ?? e)}`.slice(0, 200);
        }
    }
    return { same: Boolean(b && a === b), note };
}
