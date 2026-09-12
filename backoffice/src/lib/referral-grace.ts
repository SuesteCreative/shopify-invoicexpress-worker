import { INVITEE_FREE_DAYS } from "./referral";

/**
 * `./stripe` is imported lazily, inside the call, and that is not an accident:
 * it pulls in @cloudflare/next-on-pages, which pulls in `server-only`, which
 * refuses to load under vitest. Same reason admin-stats-sql.ts is kept apart
 * from its route. Keeping it out of the module body is what lets the rule below
 * be tested at all.
 */
async function accountConnectionKeys(db: D1Database, userId: string): Promise<string[]> {
    const { listAccountConnections, primaryConnectionKey } = await import("./stripe");
    const conns = await listAccountConnections(db, userId);
    return conns.length ? conns.map((c) => c.key) : [await primaryConnectionKey(db, userId)];
}

/**
 * The invitee's free month, put where the gate will actually look for it.
 *
 * The grace is `early_bird = 1` with a `trial_end` on a `subscriptions` row, and
 * since migration 0044 that row is keyed by (user_id, connection_key). With
 * SUBSCRIPTION_PER_CONNECTION=1 the gate looks up the row for the EXACT pair it
 * is invoicing, and does not fall back. So a grace written against a guessed key
 * is a grace the merchant never receives.
 *
 * And a guess is all that is available at claim time: someone who just followed
 * a referral link has no connection at all, so primaryConnectionKey() answers
 * the default, "shopify:invoicexpress", for somebody who may only ever set up
 * Lodgify. They would connect, be blocked, and be told to subscribe, holding an
 * email that promised them a free month.
 *
 * So this runs again from /api/auth/sync, which every integration and onboarding
 * page already calls: whatever they connect, the grace lands on it the next time
 * a page loads. That only works because the end date is anchored to the CLAIM,
 * never to now — otherwise each visit would push the free month another thirty
 * days out, for ever.
 */

/** ISO instant, thirty days after the claim. Fixed, however often this runs. */
export function graceEndFrom(claimedAt: string): string {
    // `claimed_at` comes back in either of the two formats this database holds:
    // "2026-09-12 14:52:25" from CURRENT_TIMESTAMP, or ISO with a T and a Z.
    // The space form is UTC, and Date parses it as local time, so normalise it.
    const iso = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(claimedAt)
        ? claimedAt.replace(" ", "T") + "Z"
        : claimedAt;
    return new Date(new Date(iso).getTime() + INVITEE_FREE_DAYS * 86_400_000).toISOString();
}

/**
 * Apply a pending referral's free month to every connection the account has.
 *
 * Cheap enough to call on every session sync: one primary-key lookup, and it
 * stops at the first line for anyone who was never referred, which is almost
 * everybody. Returns the number of rows it granted on.
 */
export async function grantReferralGrace(
    db: D1Database,
    userId: string,
    now = new Date(),
    /** Test seam. Production passes nothing and the real connection list is used. */
    keysFor: (db: D1Database, userId: string) => Promise<string[]> = accountConnectionKeys,
): Promise<number> {
    if (!userId) return 0;

    const ref: any = await db.prepare(
        "SELECT state, claimed_at FROM referrals WHERE invitee_user_id = ?"
    ).bind(userId).first();
    // Only while the free month is what they are living on. Once they have paid,
    // the state moves on and this must never write an early-bird row over a
    // paying account.
    if (!ref || ref.state !== "pending") return 0;

    const trialEnd = graceEndFrom(String(ref.claimed_at));
    if (new Date(trialEnd) <= now) return 0; // the free month is over

    const keys = await keysFor(db, userId);

    let granted = 0;
    for (const key of keys) {
        const res = await db.prepare(`
            INSERT INTO subscriptions (user_id, connection_key, status, early_bird, trial_end, updated_at)
            VALUES (?, ?, 'trialing', 1, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, connection_key) DO UPDATE SET
              early_bird = 1,
              trial_end  = excluded.trial_end,
              updated_at = CURRENT_TIMESTAMP
            WHERE subscriptions.stripe_subscription_id IS NULL
              AND subscriptions.status NOT IN ('active','past_due','unpaid','canceled')
              -- Never shorten a grace somebody already has. An admin-set
              -- early-bird date is a decision, and a referral must not overwrite
              -- it with a nearer one.
              AND (subscriptions.trial_end IS NULL
                   OR datetime(subscriptions.trial_end) < datetime(excluded.trial_end))
        `).bind(userId, key, trialEnd).run();
        granted += (res as any)?.meta?.changes ?? 0;
    }
    return granted;
}
