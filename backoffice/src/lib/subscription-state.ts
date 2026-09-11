/**
 * Who has access, and what the early-bird flag means on a given row.
 *
 * Pure, and in its own file for a reason: `lib/stripe` reaches
 * `getRequestContext`, which is server-only and cannot be loaded outside a
 * request — so the single most consequential decision in the product, the one
 * that decides whether a merchant's documents get issued, could not be covered
 * by a test. It is re-exported from `lib/stripe`, so every existing caller is
 * unchanged.
 */

export interface SubscriptionStateRow {
    status: string;
    stripe_subscription_id?: string | null;
    trial_end?: string | null;
    early_bird?: number | null;
}

export type SubscriptionUIState =
    | "active" | "trialing_earlybird" | "trialing" | "blocked" | "none" | "exempt";

/**
 * The gate's verdict: true means the pipeline refuses to invoice for them.
 *
 * No subscription row at all is blocked — a connection nobody pays for is the
 * state migration 0044 exists to make visible.
 *
 * It gates on the Stripe STATUS, not on a local trial_end, and trusts Stripe to
 * move a row from trialing to active, past_due or unpaid. Reading the local
 * timestamp instead opens a window at exactly midnight where Stripe is still
 * processing the first invoice and we would already be refusing documents.
 *
 * The one exception is the early-bird grace, which Stripe knows nothing about:
 * it is granted here, not as a Stripe trial, so the date has to be read.
 */
export function isSubscriptionBlocked(sub: SubscriptionStateRow | null | undefined): boolean {
    if (!sub) return true;
    if (["canceled", "unpaid", "incomplete_expired", "past_due", "incomplete"].includes(sub.status)) return true;
    // Must pay to run: while trialing without a Stripe sub, only early-bird users
    // inside their trial window keep access. Non-early-bird (or an expired
    // early-bird trial) is suspended — they must subscribe to activate.
    if (sub.status === "trialing" && !sub.stripe_subscription_id) {
        const earlyBirdActive = !!sub.early_bird && !!sub.trial_end && new Date(sub.trial_end) > new Date();
        if (!earlyBirdActive) return true;
    }
    return false;
}

/** The same verdict, named for a badge rather than for a gate. */
export function subscriptionUIState(sub: SubscriptionStateRow | null | undefined): SubscriptionUIState {
    if (!sub) return "none";
    if (sub.status === "exempt") return "exempt";
    if (sub.status === "active") return "active";
    if (sub.status === "trialing") {
        if (sub.stripe_subscription_id) return "trialing";  // paying inside a Stripe trial
        // Only early-bird users inside their window keep trial access; everyone
        // else (non-early-bird, or expired early-bird) is suspended → blocked.
        if (sub.early_bird && sub.trial_end && new Date(sub.trial_end) > new Date()) return "trialing_earlybird";
        return "blocked";
    }
    return "blocked";
}

/**
 * What the early-bird flag is worth on this row today.
 *
 * `early_bird` records that the deal was GRANTED, and is never turned off
 * again — so it survives the free window closing AND the client converting to a
 * paying subscription. Twenty-two rows carry it; six are an early bird in the
 * sense anyone means when they say the words.
 *
 *   none       the deal was never given
 *   running    the window is open and the gate is honouring it
 *   converted  they pay now, and the flag is history
 *   expired    the window closed and nobody subscribed — the gate blocks them
 *
 * Derived from subscriptionUIState rather than re-reading the dates, so there is
 * one decision about access and this only names it.
 */
export type EarlyBirdState = "none" | "running" | "converted" | "expired";

export function earlyBirdState(sub: SubscriptionStateRow | null | undefined): EarlyBirdState {
    if (!sub?.early_bird) return "none";
    const state = subscriptionUIState(sub);
    if (state === "trialing_earlybird") return "running";
    if (state === "active" || state === "trialing" || state === "exempt") return "converted";
    return "expired";
}
