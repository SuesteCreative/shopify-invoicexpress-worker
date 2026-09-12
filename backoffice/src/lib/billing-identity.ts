/**
 * Who the account is, for matching a payment to the Kapta document that invoiced
 * it.
 *
 * There are two places this identity can live and they fill on different paths.
 * `subscriptions.nif/name/email/address/zip` is a copy taken from the Checkout
 * Session, so it exists only for clients who went through the payment form.
 * `users.nif/name/company_name/fiscal_address/email` is what the onboarding
 * writes, and it exists for everyone.
 *
 * A client invited with a link that carries an existing subscription never sees
 * a checkout: `linkSubscriptionToConnection` inserts the row without a single
 * fiscal column. Every caller read only `subscriptions`, so those accounts
 * matched on amount and date alone — and a payment matched on amount alone lands
 * on whatever document of whatever client happens to be the same price. 31 of
 * the fleet's 42 subscriptions had no identity at all when this was written, 28
 * of them with the data sitting in `users` all along.
 *
 * So: the checkout copy first (it is the identity that actually paid), the
 * profile second, and never an empty string as if it were an answer.
 */

export interface BillingIdentity {
    nif: string | null;
    name: string | null;
    email: string | null;
    address: string | null;
    zip: string | null;
}

/**
 * The SELECT list, for a statement that joins `subscriptions s` and `users u`.
 *
 * Aggregated because an account holds one subscription row per connection, and a
 * plain join would both multiply the rows and let a connection with no identity
 * answer for one that has it. Any statement using this needs a GROUP BY.
 */
export const BILLING_IDENTITY_COLUMNS = `
        COALESCE(MAX(NULLIF(s.nif, '')), MAX(NULLIF(u.nif, ''))) AS nif,
        COALESCE(MAX(NULLIF(s.name, '')), MAX(NULLIF(u.company_name, '')), MAX(NULLIF(u.name, ''))) AS name,
        COALESCE(MAX(NULLIF(s.email, '')), MAX(NULLIF(u.email, ''))) AS email,
        COALESCE(MAX(NULLIF(s.address, '')), MAX(NULLIF(u.fiscal_address, ''))) AS address,
        MAX(NULLIF(s.zip, '')) AS zip`;

/** The same answer for one account. */
export async function loadBillingIdentity(db: any, userId: string): Promise<BillingIdentity> {
    const row: any = await db.prepare(`
        SELECT ${BILLING_IDENTITY_COLUMNS}
        FROM users u
        LEFT JOIN subscriptions s ON s.user_id = u.id
        WHERE u.id = ?
        GROUP BY u.id
    `).bind(userId).first();
    return {
        nif: row?.nif ?? null,
        name: row?.name ?? null,
        email: row?.email ?? null,
        address: row?.address ?? null,
        zip: row?.zip ?? null,
    };
}
