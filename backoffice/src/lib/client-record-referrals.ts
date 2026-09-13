import { ACCOUNT_LABEL_SQL } from "./labels";
import { MAX_REWARDS } from "./referral";

/**
 * The referral campaign, from one account's side: who brought it in, and whom
 * it brought.
 *
 * Both columns of `referrals` hold ACCOUNT ids, never a seat: the claim route
 * files the invitee through resolveAccountUser and the inviter through the
 * customer-number resolver, which already sends a member's code to the owner.
 * So the id the record resolved is the one to look up, in both directions.
 *
 * `invitee_paid` is the notion /api/admin/referrals reads, on purpose the same
 * SQL: a reward is granted when the invitee's subscription is created, before
 * any money arrives, and the record has to show the same answer the campaign
 * card does or the two pages disagree about whether a reward was abuse.
 */

const INVITEE_PAID_SQL = `EXISTS (SELECT 1 FROM billing_events b
                   WHERE b.user_id = r.invitee_user_id
                     AND b.type = 'invoice.paid'
                     AND COALESCE(b.amount_cents, 0) > 0)`;

export interface AccountReferrals {
    invited_by: {
        inviter_user_id: string;
        inviter_label: string | null;
        inviter_client_code: string | null;
        state: string;
        claimed_at: string;
        reward_until: string | null;
    } | null;
    invited: {
        invitee_user_id: string;
        invitee_label: string | null;
        invitee_client_code: string | null;
        state: string;
        claimed_at: string;
        invitee_subscribed_at: string | null;
        reward_until: string | null;
        void_reason: string | null;
        note: string | null;
        invitee_paid: boolean;
    }[];
    /** Counted exactly as rewardInviter counts the ceiling, so N/3 here is the
     *  number that decides whether the next referral is paid. */
    rewards_used: number;
    max_rewards: number;
}

export async function loadAccountReferrals(db: any, accountId: string): Promise<AccountReferrals> {
    const [by, out] = await Promise.all([
        // The inviter's CURRENT number first: the stored one is whatever code the
        // link carried, which can be a colleague's seat. The stored one still
        // answers when the inviting account is gone, and the record then says
        // the number is retired rather than showing nothing.
        db.prepare(`
            SELECT r.inviter_user_id,
                   COALESCE(inv.client_code, r.inviter_client_code) AS inviter_client_code,
                   ${ACCOUNT_LABEL_SQL("inv")} AS inviter_label,
                   r.state, r.claimed_at, r.reward_until
              FROM referrals r
              LEFT JOIN users inv ON inv.id = r.inviter_user_id
             WHERE r.invitee_user_id = ?
        `).bind(accountId).first(),

        // Unlimited invitations, so no LIMIT: the count below has to see every row.
        db.prepare(`
            SELECT r.invitee_user_id,
                   ite.client_code AS invitee_client_code,
                   ${ACCOUNT_LABEL_SQL("ite")} AS invitee_label,
                   r.state, r.claimed_at, r.invitee_subscribed_at, r.reward_until,
                   r.void_reason, r.note,
                   ${INVITEE_PAID_SQL} AS invitee_paid
              FROM referrals r
              LEFT JOIN users ite ON ite.id = r.invitee_user_id
             WHERE r.inviter_user_id = ?
             ORDER BY r.claimed_at DESC
        `).bind(accountId).all(),
    ]);

    const invited = (((out as any)?.results ?? []) as any[])
        .map((r) => ({ ...r, invitee_paid: Boolean(r.invitee_paid) }));

    return {
        invited_by: by ? { ...(by as any) } : null,
        invited,
        rewards_used: invited.filter((r) => r.state === "rewarded").length,
        max_rewards: MAX_REWARDS,
    };
}
