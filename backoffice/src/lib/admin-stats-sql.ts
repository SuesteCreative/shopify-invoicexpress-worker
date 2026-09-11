/**
 * The SQL behind /api/admin/stats, kept apart from the route so it can be run
 * for real in a test.
 *
 * These queries decide what the admin overview says the business earned, and
 * every one of them is defending against something that has actually happened
 * to this data:
 *
 * - A paid invoice can exist as TWO rows in `billing_events`. The Stripe webhook
 *   keys the row on `event.id`; the manual backfill in
 *   /api/admin/link-subscription keys it on `inv.id`. Both write the same
 *   `stripe_object_id`, and `INSERT OR IGNORE` cannot see the collision because
 *   the primary keys differ. A plain SUM therefore bills the same money twice.
 * - Refunds are stored POSITIVE: `charge.refunded` carries `amount_refunded`.
 *   Net revenue is paid minus refunded, never one SUM over both.
 * - `created_at` holds two formats across the fleet — `2026-09-08 14:52:25` from
 *   CURRENT_TIMESTAMP and ISO with a T and a Z from application code. They sort
 *   differently at position 11, so anything that groups by month must use
 *   substr(...,1,7), which both forms agree on.
 *
 * /api/billing/invoices collapses the same duplicates in JS for the merchant's
 * own ledger. This is the SQL expression of that rule.
 */

/** One row per paid Stripe invoice, duplicates collapsed. */
export const PAID_ROWS = `
  SELECT COALESCE(stripe_object_id, id) AS obj,
         MIN(created_at)                AS created_at,
         MAX(amount_cents)              AS amount_cents,
         MIN(currency)                  AS currency,
         MIN(user_id)                   AS user_id
  FROM billing_events
  WHERE type = 'invoice.paid' AND amount_cents IS NOT NULL
  GROUP BY COALESCE(stripe_object_id, id)
`;

/** One row per refund, collapsed the same way. */
export const REFUND_ROWS = `
  SELECT COALESCE(stripe_object_id, id) AS obj,
         MIN(created_at)                AS created_at,
         MAX(amount_cents)              AS amount_cents,
         MIN(currency)                  AS currency
  FROM billing_events
  WHERE type = 'charge.refunded' AND amount_cents IS NOT NULL
  GROUP BY COALESCE(stripe_object_id, id)
`;

/**
 * Accounts that represent a paying customer.
 *
 * Not us — an admin account is exempt from billing by role, and counting one as
 * a conversion flatters every funnel on the page. Not a colleague either: an
 * invited extra user (migration 0039) has a `users` row but bills through the
 * account that invited them, so counting them doubles that customer.
 */
export const CUSTOMERS = `
  SELECT u.* FROM users u
  WHERE COALESCE(u.role, 'user') = 'user'
    AND NOT EXISTS (
      SELECT 1 FROM account_members m
      WHERE m.member_user_id = u.id AND m.status = 'active'
    )
`;

/** The same, on a database that predates migration 0039. */
export const CUSTOMERS_LEGACY = `
  SELECT u.* FROM users u WHERE COALESCE(u.role, 'user') = 'user'
`;

/** Gross, refunded and (by subtraction) net euros per calendar month. */
export const REVENUE_BY_MONTH = `
  SELECT ym,
         SUM(gross)    AS gross_cents,
         SUM(refunded) AS refunded_cents
  FROM (
    SELECT substr(created_at, 1, 7) AS ym, amount_cents AS gross, 0 AS refunded
    FROM (${PAID_ROWS}) WHERE LOWER(COALESCE(currency, 'eur')) = 'eur'
    UNION ALL
    SELECT substr(created_at, 1, 7) AS ym, 0 AS gross, amount_cents AS refunded
    FROM (${REFUND_ROWS}) WHERE LOWER(COALESCE(currency, 'eur')) = 'eur'
  )
  GROUP BY ym ORDER BY ym
`;

/** Everything the euro series above leaves out, so it is visible rather than lost. */
export const OTHER_CURRENCIES = `
  SELECT LOWER(currency) AS currency, COUNT(*) AS n, SUM(amount_cents) AS cents
  FROM (${PAID_ROWS})
  WHERE LOWER(COALESCE(currency, 'eur')) <> 'eur'
  GROUP BY LOWER(currency)
`;

/** Sign-ups per calendar month, customers only. */
export const SIGNUPS_BY_MONTH = (customers: string) => `
  SELECT substr(created_at, 1, 7) AS ym, COUNT(*) AS n
  FROM (${customers})
  WHERE created_at IS NOT NULL
  GROUP BY ym ORDER BY ym
`;

/**
 * The onboarding funnel. Each stage is a subset of the one before it:
 * an account exists, its fiscal details are filled in, an integration is wired,
 * a subscription is being paid. `mid_setup` is the abandoned-wizard bucket —
 * a connection row that never left `draft`.
 */
export const FUNNEL = (customers: string) => `
  SELECT
    COUNT(*) AS accounts,
    SUM(CASE WHEN COALESCE(registration_completed, 0) = 1 THEN 1 ELSE 0 END) AS registered,
    SUM(CASE WHEN EXISTS (SELECT 1 FROM connections c WHERE c.user_id = u.id)
               OR EXISTS (SELECT 1 FROM integrations i WHERE i.user_id = u.id AND i.shopify_domain IS NOT NULL)
             THEN 1 ELSE 0 END) AS connected,
    SUM(CASE WHEN EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.status = 'active')
             THEN 1 ELSE 0 END) AS paying,
    SUM(CASE WHEN EXISTS (SELECT 1 FROM connections c WHERE c.user_id = u.id AND c.status = 'draft')
             THEN 1 ELSE 0 END) AS mid_setup
  FROM (${customers}) u
`;

/**
 * Documents issued per month.
 *
 * Caveat that belongs with the number, not in a ticket: `processed_orders` is
 * written with INSERT OR REPLACE, so an admin re-emission rewrites `created_at`
 * and moves that sale into the current month. Old months drift down slowly.
 */
export const DOCUMENTS_BY_MONTH = `
  SELECT substr(created_at, 1, 7) AS ym, COUNT(*) AS n
  FROM processed_orders
  WHERE invoice_id IS NOT NULL AND created_at IS NOT NULL
  GROUP BY ym ORDER BY ym
`;

/** Where the accounts we have came from — blind to anyone who never signed up. */
export const CHANNELS = (customers: string) => `
  SELECT COALESCE(NULLIF(acq_utm_source, ''), NULLIF(acq_referrer, ''), 'direto') AS source,
         COUNT(*) AS n
  FROM (${customers})
  WHERE acq_captured_at IS NOT NULL
  GROUP BY source ORDER BY n DESC LIMIT 12
`;

/** How much of the funnel has no attribution at all — the honesty metric. */
export const ATTRIBUTION_COVERAGE = (customers: string) => `
  SELECT COUNT(*) AS total,
         SUM(CASE WHEN acq_captured_at IS NOT NULL THEN 1 ELSE 0 END) AS captured
  FROM (${customers})
`;

/** Subscriptions by state and by connection. */
export const SUBSCRIPTIONS_BY_STATE = `
  SELECT status, connection_key, COUNT(*) AS n
  FROM subscriptions
  GROUP BY status, connection_key
  ORDER BY n DESC
`;

/**
 * Extra-seat revenue.
 *
 * Only from here. A seat's `billing_events` row is a `checkout.session.completed`
 * with no amount on it at all, and the nightly TTL purge deletes that type after
 * 90 days — seats are bought through a `mode: "payment"` Checkout that emits no
 * Stripe invoice, so no `invoice.paid` ever arrives for them.
 */
export const SEAT_REVENUE = `
  SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM account_seats
`;
