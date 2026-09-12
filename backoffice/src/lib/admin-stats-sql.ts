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
  WHERE type = 'invoice.paid' AND amount_cents IS NOT NULL AND created_at IS NOT NULL
  GROUP BY COALESCE(stripe_object_id, id)
`;

/**
 * One row per refunded CHARGE, not per refund event.
 *
 * A charge can be refunded in instalments, and Stripe sends `charge.refunded`
 * once per instalment carrying `amount_refunded` — which is the RUNNING TOTAL,
 * not the increment. The webhook keys each of those rows on the latest refund's
 * own id, so they never collide. Grouping on that id therefore keeps 10 € and
 * then 25 € as two rows and sums them to 35 € against a charge that was only
 * ever refunded 25 €.
 *
 * The payment intent is the stable identity of the charge, so grouping on it and
 * taking MAX collapses the ladder back to its last rung, which is the answer.
 */
export const REFUND_ROWS = `
  SELECT COALESCE(payment_intent_id, stripe_object_id, id) AS obj,
         MIN(created_at)                                   AS created_at,
         MAX(amount_cents)                                 AS amount_cents,
         MIN(currency)                                     AS currency,
         MIN(user_id)                                      AS user_id
  FROM billing_events
  WHERE type = 'charge.refunded' AND amount_cents IS NOT NULL AND created_at IS NOT NULL
  GROUP BY COALESCE(payment_intent_id, stripe_object_id, id)
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

/**
 * Does this account have a pipe at all?
 *
 * Two places to look, and forgetting the second is the classic mistake on this
 * schema: the legacy Shopify→InvoiceXpress integration has no `connections` row,
 * it is columns on `integrations`. An account wired up that way is a customer
 * with a working pipe that a `connections`-only test calls empty.
 */
export const HAS_PIPE = (alias = "u") => `(
  EXISTS (SELECT 1 FROM connections c WHERE c.user_id = ${alias}.id)
  OR EXISTS (SELECT 1 FROM integrations i WHERE i.user_id = ${alias}.id AND i.shopify_domain IS NOT NULL)
)`;

/**
 * The subscription gate, as one expression.
 *
 * Mirrors isSubscriptionBlocked() in lib/subscription-state.ts and rowAllows()
 * in the worker's subscription-gate.ts. It lives here alone so the admin page,
 * the funnel and the newsletter audience cannot each grow their own dialect of
 * "is this account allowed to invoice" — three expressions of the rule would be
 * three chances to get it wrong, and the one that drifts would be the one nobody
 * is looking at.
 */
export const GATE_OPEN = (alias = "u") => `EXISTS (
    SELECT 1 FROM subscriptions s
    WHERE s.user_id = ${alias}.id
      AND s.status NOT IN ('canceled','unpaid','incomplete_expired','past_due','incomplete')
      AND (
        s.status <> 'trialing'
        OR s.stripe_subscription_id IS NOT NULL
        -- An early bird keeps access until the INSTANT its trial ends, which is
        -- what the gate compares. Comparing dates instead granted a whole extra
        -- day here: on the last day of a trial this page said invoicing was fine
        -- while the worker was already refusing it. datetime() is what makes the
        -- two forms comparable — trial_end is ISO with a T and a Z, and the raw
        -- strings sort wrong against each other from position 11.
        OR (COALESCE(s.early_bird, 0) = 1
            AND s.trial_end IS NOT NULL
            AND datetime(s.trial_end) > datetime('now'))
      )
  )`;

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
 * The onboarding funnel, genuinely nested.
 *
 * Each stage carries the conditions of the stages above it. Three independent
 * predicates over the same rows would not be a funnel: a paying account whose
 * fiscal form was never completed would make "a pagar" larger than "dados
 * preenchidos", and the bar would render wider than the one above it while the
 * card claims each stage is a subset of the last. That it happens to come out
 * monotonic today is luck, not arithmetic.
 *
 * `mid_setup` is deliberately NOT a stage — it is a side note counting accounts
 * whose connection never left `draft`, i.e. someone who walked out of a wizard.
 */
export const FUNNEL = (customers: string) => `
  SELECT
    COUNT(*) AS accounts,
    SUM(CASE WHEN reg THEN 1 ELSE 0 END)                   AS registered,
    SUM(CASE WHEN reg AND conn THEN 1 ELSE 0 END)          AS connected,
    SUM(CASE WHEN reg AND conn AND pay THEN 1 ELSE 0 END)  AS paying,
    SUM(CASE WHEN draft THEN 1 ELSE 0 END)                 AS mid_setup
  FROM (
    SELECT
      COALESCE(u.registration_completed, 0) = 1 AS reg,
      ${HAS_PIPE("u")} AS conn,
      EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.status = 'active') AS pay,
      EXISTS (SELECT 1 FROM connections c WHERE c.user_id = u.id AND c.status = 'draft')    AS draft
    FROM (${customers}) u
  )
`;

/**
 * Accounts the worker is currently refusing to invoice for.
 *
 * The single most useful number on the page, and the one the funnel cannot
 * show: an account can be wired up and still have every document blocked at the
 * subscription gate. This mirrors isSubscriptionBlocked() in lib/stripe.ts — a
 * dead status, or a trial that has no Stripe subscription behind it and whose
 * early-bird grace has run out. Keep the two in step: if the gate changes and
 * this does not, the page will say invoicing is fine while it is not.
 */
export const BLOCKED_BY_GATE = (customers: string) => `
  SELECT COUNT(*) AS n
  FROM (${customers}) u
  WHERE ${HAS_PIPE("u")}
  AND NOT ${GATE_OPEN("u")}
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
    -- The page says "customer accounts only", so our own dev-mode and test
    -- shops must not be inside the count. Rows from before migration 0012 have
    -- no user_id at all and are kept: they are real documents for real clients.
    AND (user_id IS NULL
         OR user_id IN (SELECT id FROM users WHERE COALESCE(role, 'user') = 'user'))
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
