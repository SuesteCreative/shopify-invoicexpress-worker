import { normalizeClientCode } from "./client-code";

/**
 * "Convida 1 amigo, recebem os dois 2 meses grátis."
 *
 * The rules live here because they are promises made in writing to clients, and
 * the terms page and this file have to say the same thing:
 *
 *   - both sides get 2 free months;
 *   - whoever invites needs an account AND a live subscription — the reward is
 *     two months added to a subscription, so there has to be one to add them to;
 *   - whoever is invited finishes onboarding and leaves a card. Their
 *     subscription is created with a 2-month trial and Stripe charges it on its
 *     own at the end. Nothing here grants that: it is `trial_period_days` on the
 *     Checkout, and the gate already lets a Stripe trial through;
 *   - unlimited invitations, at most 3 rewards, so at most 6 free months;
 *   - claims close on 31 October. The REWARD does not: somebody who invited on
 *     the 30th and whose friend subscribes in November is owed those months, and
 *     gets them. That distinction is in the terms and has to stay true here.
 *
 * THE INVITE CODE IS THE CUSTOMER NUMBER, plus a suffix. `RIO-1A2B3C-9F2B41`.
 * One number per client — the one they dictate on the phone, the one on their
 * record, the one the newsletter files a campaign under — and the suffix is what
 * keeps migration 0058's rule intact: the number never opens a public page naked.
 */

export const CAMPAIGN_END = "2026-10-31";
export const REWARD_MONTHS = 2;
/** 3 × 2 months = the 6-month ceiling the campaign copy promises. */
export const MAX_REWARDS = 3;
/** How new "conta nova" means. Wide enough to sign up, look around, come back. */
export const NEW_ACCOUNT_WINDOW_DAYS = 7;

const SUFFIX_RE = /^[0-9A-F]{6}$/;
const HEX = "0123456789ABCDEF";

/** Six hex characters, the same shape and alphabet as the customer number. */
export function newReferralSuffix(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(3));
    let out = "";
    for (const b of bytes) out += HEX[(b >> 4) & 0xf] + HEX[b & 0xf];
    return out;
}

export function referralToken(clientCode: string, suffix: string): string {
    return `${clientCode}-${suffix}`;
}

/**
 * `RIO-1A2B3C-9F2B41` → its two halves, or null.
 *
 * The customer number carries a dash of its own, so the token has three
 * segments and the LAST one is the suffix. The code half goes through
 * normalizeClientCode rather than a second regex — one normaliser, in
 * lib/client-code, or the two drift and a link stops resolving for a reason
 * nobody can see.
 */
export function splitReferralToken(raw: unknown): { code: string; suffix: string } | null {
    if (typeof raw !== "string") return null;
    const parts = raw.trim().toUpperCase().split("-").filter(Boolean);
    if (parts.length !== 3) return null;
    const code = normalizeClientCode(`${parts[0]}-${parts[1]}`);
    const suffix = parts[2];
    if (!code || !SUFFIX_RE.test(suffix)) return null;
    return { code, suffix };
}

/**
 * The link opens in the language of whoever shares it: an English dashboard
 * handing out a Portuguese landing read as a mistake. Only the path segment
 * changes, never the token. The caller validates the locale against the routing;
 * this file stays free of next-intl so the root test run can import it.
 */
export function referralLink(token: string, locale = "pt"): string {
    return `https://rioko.online/${locale}/convite/${token}`;
}

export type ReferralRefusal =
    | "invalid"          // not a token shape
    | "unknown"          // no such code, or the suffix does not match
    | "self"             // inviting yourself
    | "closed"           // the campaign is over
    | "not_new"          // this account has been here too long to be a referral
    | "already"          // already referred by somebody
    | "inviter_inactive"  // whoever invited has no live subscription to add months to
    | "already_subscribed" // the invitee already pays us: clause 4 is new customers only
    | "too_many";        // too many wrong codes typed in an hour

/**
 * How many wrong codes an account may type in an hour, and over what window.
 *
 * The code can also be typed by hand now, because a link only ever reached the
 * browser that opened it. Guessing one is not a real threat — a customer number
 * and its suffix are six hex characters each — but an authenticated loop should
 * not get several D1 reads and a Clerk call per try for free. A friend types the
 * code they were sent once, or twice if they fumble it.
 */
export const CLAIM_ATTEMPT_LIMIT = 10;
export const CLAIM_ATTEMPT_WINDOW_MINUTES = 60;

/**
 * Whether a refusal is somebody fishing for a code, rather than a right answer
 * about a real one.
 *
 * Only a token that does not parse, or one that resolves to nobody, says
 * anything about guessing. "You are not new any more" and "someone already
 * invited this account" are answers about a code that exists, and counting them
 * would lock out the one person who read their own invite twice.
 */
export function countsTowardClaimLimit(refusal: ReferralRefusal | null): boolean {
    return refusal === "invalid" || refusal === "unknown";
}

export interface ClaimContext {
    token: string;
    inviterUserId: string | null;
    inviterHasLiveSubscription: boolean;
    inviteeUserId: string;
    /** users.created_at for the invitee, in either timestamp format. */
    inviteeCreatedAt: string | null;
    /**
     * Clerk's own createdAt (epoch ms), for when users.created_at is not there
     * yet: the Clerk webhook that writes the row can land after the first claim.
     */
    inviteeSignedUpAt?: number | null;
    alreadyReferred: boolean;
    /** The invitee already holds a Stripe subscription. Optional: absent means no. */
    inviteeHasSubscription?: boolean;
    now: Date;
}

/**
 * Why a claim is refused, or null when it stands.
 *
 * Pure and date-injected: the campaign boundary is a promise with a date on it,
 * and a rule that can only be exercised by waiting for November is a rule nobody
 * checks.
 */
export function claimRefusal(ctx: ClaimContext): ReferralRefusal | null {
    if (!splitReferralToken(ctx.token)) return "invalid";
    if (!ctx.inviterUserId) return "unknown";
    if (ctx.inviterUserId === ctx.inviteeUserId) return "self";
    if (ctx.alreadyReferred) return "already";
    if (ctx.inviteeHasSubscription) return "already_subscribed";

    const today = ctx.now.toISOString().slice(0, 10);
    if (today > CAMPAIGN_END) return "closed";

    if (!ctx.inviterHasLiveSubscription) return "inviter_inactive";

    // Both timestamp formats live in users.created_at — "2026-09-08 14:52:25"
    // from CURRENT_TIMESTAMP and ISO with a T and a Z from application code —
    // and they sort wrong against each other from position 11. Compare dates.
    //
    // A missing row used to skip this rule altogether, so an old Clerk account
    // whose D1 row the webhook had not written yet passed as new. Clerk's date
    // fills in, and with neither nothing proves the account is new: refused.
    const created = ctx.inviteeCreatedAt
        ? String(ctx.inviteeCreatedAt).slice(0, 10)
        : ctx.inviteeSignedUpAt != null
            ? new Date(ctx.inviteeSignedUpAt).toISOString().slice(0, 10)
            : null;
    const cutoff = new Date(ctx.now.getTime() - NEW_ACCOUNT_WINDOW_DAYS * 86_400_000)
        .toISOString().slice(0, 10);
    if (!created || created < cutoff) return "not_new";
    return null;
}

/**
 * A claim from an account that already has a referral row.
 *
 * The same inviter again is a replay (the landing and the layout both claim, a
 * reload claims again) and answers ok whatever has changed since: by then they
 * may well have subscribed, which is the point. A different inviter is a second
 * person's link, and the first one stands. Answering "registado" to it had a
 * second friend waiting for two months that were never theirs to give.
 */
export function existingClaim(
    existingInviterUserId: string | null | undefined,
    inviterUserId: string | null,
): "none" | "same" | "other" {
    if (!existingInviterUserId) return "none";
    return String(existingInviterUserId) === inviterUserId ? "same" : "other";
}

/** Is the campaign still taking claims? */
export function campaignOpen(now = new Date()): boolean {
    return now.toISOString().slice(0, 10) <= CAMPAIGN_END;
}
