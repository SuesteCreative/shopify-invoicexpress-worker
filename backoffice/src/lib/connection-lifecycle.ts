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

/* ───────────────── the legacy Shopify → InvoiceXpress pipe ─────────────────
 *
 * It is not a `connections` row. It is a set of columns on the account's
 * `integrations` row, which also carries around thirty-five fiscal settings —
 * VAT inclusion, exemption reasons, retention, auto-finalize. So the two verbs
 * mean different things here than they do for a connection, and the difference
 * is the whole reason these are separate functions rather than a flag:
 *
 *  - reset clears the credentials and leaves the fiscal settings alone, which
 *    is what you want for a client starting their setup again;
 *  - delete removes the row, fiscal settings included, which is only ever right
 *    for a row nobody finished — a test entry, an abandoned onboarding.
 */

/** What deleting this row would take with it, so an operator sees it first. */
export interface LegacyImpact {
    configured: boolean;
    shopify_domain: string | null;
    ix_account_name: string | null;
    documents: number;
    /** Live connections that file into InvoiceXpress with these credentials. */
    dependent_connections: string[];
}

export async function legacyImpact(db: D1Database, userId: string): Promise<LegacyImpact | null> {
    const row: any = await db.prepare(
        `SELECT shopify_domain, ix_account_name FROM integrations WHERE user_id = ? LIMIT 1`
    ).bind(userId).first();
    if (!row) return null;

    // EVERY document, not just Shopify's.
    //
    // This count is the only thing standing between an operator and deleting
    // the row, and it used to read `source_kind IS NULL OR = 'shopify'`. On
    // 2026-09-11 that reported "0 documents" for MeetFrank, whose 732 documents
    // are all source_kind='stripe'. The row was deleted with no warning and
    // with it the InvoiceXpress credentials, which live here for every
    // connection — Stripe, Lodgify, EuPago — and not only for Shopify.
    // Invoicing stopped dead and nothing said so.
    const docs: any = await db.prepare(
        `SELECT COUNT(*) AS n FROM processed_orders
          WHERE user_id = ? AND invoice_id IS NOT NULL`
    ).bind(userId).first().catch(() => ({ n: 0 }));

    // Named so the confirmation says what breaks, not just how much history
    // exists. An account with no documents yet can still have a live pipe.
    const deps: any = await db.prepare(
        `SELECT source_kind, destination_kind FROM connections
          WHERE user_id = ? AND status = 'active' AND destination_kind = 'invoicexpress'`
    ).bind(userId).all().catch(() => ({ results: [] }));

    return {
        configured: !!(row.shopify_domain || row.ix_account_name),
        shopify_domain: row.shopify_domain ?? null,
        ix_account_name: row.ix_account_name ?? null,
        documents: Number(docs?.n ?? 0),
        dependent_connections: ((deps?.results ?? []) as any[])
            .map((r) => `${r.source_kind} → ${r.destination_kind}`),
    };
}

/**
 * Clear the credentials, keep the row and every fiscal setting on it.
 *
 * Guarded like the delete, and for the same reason: the InvoiceXpress half of
 * this row is what every non-Shopify connection authenticates with, so wiping
 * it stops a live pipe just as dead as deleting the row would.
 */
export async function resetLegacyIntegration(
    db: D1Database,
    userId: string,
    force = false,
): Promise<DeleteResult | { ok: false; requires_force: true; impact: LegacyImpact }> {
    const impact = await legacyImpact(db, userId);
    if (impact && !force && impact.dependent_connections.length > 0) {
        return { ok: false, requires_force: true, impact };
    }
    return resetLegacyIntegrationUnguarded(db, userId);
}

async function resetLegacyIntegrationUnguarded(db: D1Database, userId: string): Promise<DeleteResult> {
    const res: any = await db.prepare(
        `UPDATE integrations
            SET shopify_domain = NULL, shopify_token = NULL, shopify_webhook_secret = NULL,
                ix_account_name = NULL, ix_api_key = NULL,
                shopify_authorized = 0, ix_authorized = 0, webhooks_active = 0,
                shopify_error = NULL, ix_error = NULL,
                updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ?`
    ).bind(userId).run();

    if ((res?.meta?.changes ?? 0) === 0) return { ok: true, already_gone: true };
    return { ok: true };
}

/**
 * Remove the legacy integration row outright.
 *
 * Takes the account's fiscal settings with it, so it is guarded: a pipe that
 * has issued documents refuses unless the caller says `force`, and says what is
 * attached rather than asking "are you sure?", which nobody reads. Same shape
 * as the account delete in /api/admin/users, and for the same reason — an
 * account was once deleted whole because nothing had asked.
 *
 * `processed_orders` and the documents themselves stay, exactly as elsewhere.
 */
export async function deleteLegacyIntegration(
    db: D1Database,
    userId: string,
    force = false,
): Promise<DeleteResult | { ok: false; requires_force: true; impact: LegacyImpact }> {
    const impact = await legacyImpact(db, userId);
    if (!impact) return { ok: true, already_gone: true };

    // A live connection is as good a reason to stop as a history of documents,
    // and a stronger one: history is only lost context, a live pipe is money
    // that stops being invoiced tonight.
    if (!force && (impact.documents > 0 || impact.dependent_connections.length > 0)) {
        return { ok: false, requires_force: true, impact };
    }

    await db.prepare("DELETE FROM integrations WHERE user_id = ?").bind(userId).run();
    return { ok: true };
}

/** The legacy pipe's kill switch, which the worker's pause gate already reads. */
export async function setLegacyPaused(
    db: D1Database,
    userId: string,
    paused: boolean,
): Promise<{ ok: boolean; already_gone?: true }> {
    const res: any = await db.prepare(
        `UPDATE integrations SET is_paused = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`
    ).bind(paused ? 1 : 0, userId).run();

    if ((res?.meta?.changes ?? 0) === 0) return { ok: true, already_gone: true };
    return { ok: true };
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
