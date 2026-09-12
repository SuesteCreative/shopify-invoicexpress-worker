import { newInviteToken, isValidToken, TOKEN_PATTERN } from "./onboarding-invites";

/**
 * "Convide um amigo, ganhe 2 meses."
 *
 * The rules, in one place, because they are promises made in writing to clients
 * and the copy in Claude outputs/rioko-convite-pt.txt is the specification:
 *
 *   - 2 free months for the inviter, per referral, no cap.
 *   - 1 free month for the invitee, no card.
 *   - The campaign ends 31 October. What has to happen by then is the CLAIM —
 *     "contam os convites em que a conta nova liga a primeira integração até essa
 *     data" — not the payment, which may land later. So the end date closes the
 *     claim and never the credit: someone who invited on the 30th and whose
 *     friend pays in November is owed the two months, and gets them.
 *   - "Válido para contas novas": an account that has been around for a while
 *     cannot retroactively be somebody's referral.
 *
 * The invitee's free month is not a Stripe coupon. It is `early_bird = 1` with a
 * `trial_end` thirty days out, which is what the gate already reads — the same
 * grace the Shopify pilots had. That is also the only version of this that is
 * honestly "sem cartão": a 100%-off coupon still walks the merchant through a
 * Checkout, and a Checkout that collects no card leaves the second month to fail.
 */

/** The token shape is the onboarding invite's, which is tested and known good:
 *  a readable slug plus 12 hex, so the company name alone is never the secret. */
export { newInviteToken as newReferralCode, isValidToken as isValidReferralCode, TOKEN_PATTERN };

export const CAMPAIGN_END = "2026-10-31";
export const INVITEE_FREE_DAYS = 30;
/** How new "conta nova" means. Wide enough that someone can sign up, look
 *  around, and come back to the link the next day. */
export const NEW_ACCOUNT_WINDOW_DAYS = 7;

export const REFERRAL_LINK_BASE = "https://rioko.online/pt/convite";
export function referralLink(code: string): string {
    return `${REFERRAL_LINK_BASE}/${code}`;
}

export type ReferralRefusal =
    | "invalid"        // not a token shape
    | "unknown"        // no such code
    | "self"           // inviting yourself
    | "closed"         // campaign over
    | "not_new";       // the account has been here too long to be a referral

export interface ClaimContext {
    code: string;
    inviterUserId: string | null;
    inviteeUserId: string;
    /** users.created_at for the invitee, either timestamp format. */
    inviteeCreatedAt: string | null;
    now: Date;
}

/**
 * Why a claim is refused, or null when it stands.
 *
 * Deliberately pure and date-injected: the campaign boundary is a promise with a
 * date on it, and a rule that can only be exercised by waiting for November is a
 * rule nobody checks.
 */
export function claimRefusal(ctx: ClaimContext): ReferralRefusal | null {
    if (!isValidToken(ctx.code)) return "invalid";
    if (!ctx.inviterUserId) return "unknown";
    if (ctx.inviterUserId === ctx.inviteeUserId) return "self";

    const today = ctx.now.toISOString().slice(0, 10);
    if (today > CAMPAIGN_END) return "closed";

    if (ctx.inviteeCreatedAt) {
        // Both timestamp formats live in this column — "2026-09-08 14:52:25" from
        // CURRENT_TIMESTAMP and ISO with a T and a Z from application code — and
        // they sort wrong against each other from position 11. Compare the dates.
        const created = String(ctx.inviteeCreatedAt).slice(0, 10);
        const cutoff = new Date(ctx.now.getTime() - NEW_ACCOUNT_WINDOW_DAYS * 86_400_000)
            .toISOString().slice(0, 10);
        if (created < cutoff) return "not_new";
    }
    return null;
}

/** When the invitee's free month runs out, as an ISO instant — the form
 *  `trial_end` is stored in and the gate compares with datetime(). */
export function inviteeTrialEnd(now: Date): string {
    return new Date(now.getTime() + INVITEE_FREE_DAYS * 86_400_000).toISOString();
}

export const REFUSAL_PT: Record<ReferralRefusal, string> = {
    invalid: "Este link de convite não é válido.",
    unknown: "Este convite já não existe.",
    self: "Não podes usar o teu próprio link de convite.",
    closed: "A campanha de convites terminou a 31 de Outubro.",
    not_new: "Os convites são para contas novas, e esta já não é.",
};
