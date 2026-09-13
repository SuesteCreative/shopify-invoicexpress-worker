/**
 * A per-subject run lock in `sweep_state`, for a periodic job that must never
 * run twice over the same subject at the same time.
 *
 * Built for the Lodgify pass, which starts from two places — the 30-minute cron
 * and a verified webhook — while a new, paid booking fires two webhooks at once
 * (booking_new_status_booked and booking_change). Two passes over the same
 * booking both read "not processed yet" before either writes its marker, and
 * both issue a document.
 *
 * `sweep_state` already answers "when did this job last run for this subject",
 * so the lock is a namespaced key there rather than a new table and a migration
 * applied by hand. Check and write are one conditional upsert, so two callers
 * cannot both win. A holder that died without releasing stops counting after
 * `staleMs`, and the token means a holder that lost its lock that way cannot
 * release the one that took over.
 */

/** The token to release with, or null when someone else holds the lock. */
export async function claimRunLock(
    db: D1Database,
    key: string,
    staleMs: number,
    now: Date = new Date(),
): Promise<string | null> {
    const token = crypto.randomUUID();
    const r = await db.prepare(
        `INSERT INTO sweep_state (shopify_domain, last_started_at, last_status, last_detail_json)
         VALUES (?, ?, 'running', ?)
         ON CONFLICT(shopify_domain) DO UPDATE SET
           last_started_at  = excluded.last_started_at,
           last_status      = 'running',
           last_detail_json = excluded.last_detail_json
         WHERE sweep_state.last_status IS NOT 'running'
            OR sweep_state.last_started_at IS NULL
            OR sweep_state.last_started_at < ?`,
    ).bind(key, now.toISOString(), token, new Date(now.getTime() - staleMs).toISOString()).run();
    return Number(r?.meta?.changes ?? 0) > 0 ? token : null;
}

/** Release a lock this caller holds. A token that no longer matches does nothing. */
export async function releaseRunLock(
    db: D1Database,
    key: string,
    token: string,
    now: Date = new Date(),
): Promise<void> {
    await db.prepare(
        `UPDATE sweep_state
            SET last_status = 'ok', last_completed_at = ?, last_detail_json = NULL
          WHERE shopify_domain = ? AND last_status = 'running' AND last_detail_json = ?`,
    ).bind(now.toISOString(), key, token).run();
}
