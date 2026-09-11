/**
 * Deleting, resetting and pausing a connection — the operations that outlive
 * whoever asked for them.
 *
 * Extracted from /api/connections so the admin console can do the same things
 * to somebody else's account without either duplicating the cascade or forcing
 * an operator to impersonate a client just to tidy up an abandoned setup.
 *
 * The cascade is the part that must not be reimplemented twice: a connection's
 * routing rules and product mappings are keyed by (user, source, destination),
 * not by the connection's id, so leaving them behind silently applies a deleted
 * integration's rules to the next one set up under the same pair.
 */

export interface DeleteResult {
    ok: true;
    already_gone?: true;
    /** null when this connection has no Stripe authorisation to revoke. */
    revoked_at_stripe?: boolean | null;
}

/**
 * Tell Stripe before we forget the account id.
 *
 * Otherwise the merchant is left with Rioko listed as an authorised application
 * in their own Stripe dashboard, and nothing on our side able to revoke it. A
 * 400 is Stripe saying it was already disconnected, which is the state we were
 * asking for.
 */
async function revokeStripeConnect(sourceConfigJson: string | null): Promise<boolean | null> {
    const cfg = sourceConfigJson ? JSON.parse(sourceConfigJson) : {};
    if (!cfg.stripe_account_id) return null;

    // Imported here rather than at the top of the file: lib/stripe reaches
    // getRequestContext, which is server-only and cannot be loaded outside a
    // request — including by the test that covers the cascade below. Nothing
    // but a Connect connection ever needs it.
    const { getStripeEnvOptional } = await import("./stripe");
    const clientId = getStripeEnvOptional("STRIPE_CONNECT_CLIENT_ID");
    const platformKey = getStripeEnvOptional("STRIPE_SECRET_KEY");
    if (!clientId || !platformKey) return null;

    try {
        const res = await fetch("https://connect.stripe.com/oauth/deauthorize", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${platformKey}`,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ client_id: clientId, stripe_user_id: cfg.stripe_account_id }).toString(),
        });
        return res.ok || res.status === 400;
    } catch {
        return false;
    }
}

/** Remove a connection and everything keyed to the pair it occupied. */
export async function deleteConnection(
    db: D1Database,
    userId: string,
    sourceKind: string,
    destinationKind: string,
): Promise<DeleteResult> {
    const row: any = await db.prepare(
        `SELECT id, source_config_json FROM connections
          WHERE user_id = ? AND source_kind = ? AND destination_kind = ? LIMIT 1`
    ).bind(userId, sourceKind, destinationKind).first();

    if (!row) return { ok: true, already_gone: true };

    const revokedAtStripe = sourceKind === "stripe_connect"
        ? await revokeStripeConnect(row.source_config_json)
        : null;

    for (const sql of [
        "DELETE FROM tag_routing_rules WHERE user_id = ? AND source_kind = ? AND destination_kind = ?",
        "DELETE FROM product_mappings WHERE user_id = ? AND source_kind = ? AND destination_kind = ?",
    ]) {
        // Best effort: a missing side table must not leave the connection itself
        // undeletable.
        try {
            await db.prepare(sql).bind(userId, sourceKind, destinationKind).run();
        } catch { /* nothing to clean up */ }
    }

    await db.prepare("DELETE FROM connections WHERE id = ?").bind(row.id).run();

    return { ok: true, revoked_at_stripe: revokedAtStripe };
}

/**
 * Put a connection back to the state it had before anyone configured it.
 *
 * The row survives, so the pair stays claimed and the history that points at it
 * still resolves; only the credentials and behaviour go. Stripe is deauthorised
 * exactly as on a delete, because leaving a live authorisation behind a reset
 * means the merchant reconnects into an account we still hold a token for.
 *
 * Routing rules and product mappings go too: they describe a setup that no
 * longer exists, and surviving a reset is how a fresh onboarding silently
 * inherits the last one's tax routing.
 */
export async function resetConnection(
    db: D1Database,
    userId: string,
    sourceKind: string,
    destinationKind: string,
): Promise<DeleteResult> {
    const row: any = await db.prepare(
        `SELECT id, source_config_json FROM connections
          WHERE user_id = ? AND source_kind = ? AND destination_kind = ? LIMIT 1`
    ).bind(userId, sourceKind, destinationKind).first();

    if (!row) return { ok: true, already_gone: true };

    const revokedAtStripe = sourceKind === "stripe_connect"
        ? await revokeStripeConnect(row.source_config_json)
        : null;

    for (const sql of [
        "DELETE FROM tag_routing_rules WHERE user_id = ? AND source_kind = ? AND destination_kind = ?",
        "DELETE FROM product_mappings WHERE user_id = ? AND source_kind = ? AND destination_kind = ?",
    ]) {
        try {
            await db.prepare(sql).bind(userId, sourceKind, destinationKind).run();
        } catch { /* nothing to clean up */ }
    }

    await db.prepare(
        `UPDATE connections
            SET source_config_json = NULL,
                destination_config_json = NULL,
                behavior_json = NULL,
                oauth_state = NULL,
                oauth_state_expires_at = NULL,
                last_token_refresh_at = NULL,
                status = 'draft',
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`
    ).bind(row.id).run();

    return { ok: true, revoked_at_stripe: revokedAtStripe };
}

/** Pause or resume. `paused` is the kill switch the pipeline already honours. */
export async function setConnectionStatus(
    db: D1Database,
    userId: string,
    sourceKind: string,
    destinationKind: string,
    status: "active" | "paused",
): Promise<{ ok: boolean; already_gone?: true }> {
    const res: any = await db.prepare(
        `UPDATE connections SET status = ?, updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ? AND source_kind = ? AND destination_kind = ?`
    ).bind(status, userId, sourceKind, destinationKind).run();

    if ((res?.meta?.changes ?? 0) === 0) return { ok: true, already_gone: true };
    return { ok: true };
}
