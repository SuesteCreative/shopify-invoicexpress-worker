import { PAID_ROWS, REFUND_ROWS } from "./admin-stats-sql";

/**
 * The financial section's queries.
 *
 * Everything here inherits the three rules the overview's SQL documents, and
 * they are not optional: a paid invoice can exist twice under different primary
 * keys, `charge.refunded` carries a running total rather than an increment, and
 * `created_at` comes in two formats that sort differently. PAID_ROWS and
 * REFUND_ROWS are imported rather than rewritten so those rules hold in one
 * place; a second expression of them is a second chance to get them wrong.
 *
 * What is deliberately NOT here: MRR. `subscriptions` stores a `price_id` and
 * never an amount, and there are three price points in circulation, so the
 * money has to come from Stripe. The route joins it in memory.
 */

/** What each account has paid, how many times, and when it last did. */
export const PAYMENTS_BY_ACCOUNT = `
  SELECT user_id,
         SUM(amount_cents) AS gross_cents,
         COUNT(*)          AS payments,
         MAX(created_at)   AS last_payment_at
  FROM (${PAID_ROWS})
  WHERE user_id IS NOT NULL AND LOWER(COALESCE(currency, 'eur')) = 'eur'
  GROUP BY user_id
`;

/** What each account has had refunded. Kept apart from the payments so the two
 *  dedup keys — invoice for a payment, payment intent for a refund — never meet
 *  in the same GROUP BY. */
export const REFUNDS_BY_ACCOUNT = `
  SELECT user_id, SUM(amount_cents) AS refunded_cents
  FROM (${REFUND_ROWS})
  WHERE user_id IS NOT NULL AND LOWER(COALESCE(currency, 'eur')) = 'eur'
  GROUP BY user_id
`;

/**
 * What each account is signed up to, one row per pipe it pays for.
 *
 * `price_id` is the join key to Stripe. `status = 'exempt'` is our own sentinel
 * for an admin account and never reaches Stripe at all.
 */
export const SUBSCRIPTION_LINES = `
  SELECT s.user_id, s.connection_key, s.status, s.plan, s.price_id,
         s.current_period_end, s.trial_end, s.early_bird,
         s.stripe_subscription_id, s.cancel_at_period_end,
         u.email, u.name, u.company_name, u.admin_label,
         COALESCE(u.role, 'user') AS role,
         COALESCE(u.is_inactive, 0) AS is_inactive
  FROM subscriptions s
  LEFT JOIN users u ON u.id = s.user_id
  ORDER BY s.user_id
`;

/**
 * Trials running out inside the window.
 *
 * Compared on the DATE only: `trial_end` is ISO with a T and `date('now')` is
 * not, and those two sort wrong against each other from position 11 onwards.
 * Only early birds without a Stripe subscription are at risk — everyone else is
 * either already paying or already blocked.
 */
export const TRIALS_ENDING = `
  SELECT s.user_id, s.connection_key, s.trial_end,
         u.email, u.name, u.company_name, u.admin_label
  FROM subscriptions s
  LEFT JOIN users u ON u.id = s.user_id
  WHERE s.status = 'trialing'
    AND s.stripe_subscription_id IS NULL
    AND COALESCE(s.early_bird, 0) = 1
    AND s.trial_end IS NOT NULL
    AND substr(s.trial_end, 1, 10) >= date('now')
    AND substr(s.trial_end, 1, 10) <= date('now', '+30 day')
    AND COALESCE(u.role, 'user') = 'user'
  ORDER BY substr(s.trial_end, 1, 10) ASC
`;

/**
 * Charges Stripe could not collect, newest first.
 *
 * These rows survive the nightly TTL purge on purpose — dunning is the one
 * billing event only the client can fix, and the row is already there.
 */
export const FAILED_PAYMENTS = `
  SELECT b.id, b.user_id, b.amount_cents, b.currency, b.created_at,
         u.email, u.name, u.company_name, u.admin_label
  FROM billing_events b
  LEFT JOIN users u ON u.id = b.user_id
  WHERE b.type = 'invoice.payment_failed'
  ORDER BY b.created_at DESC
  LIMIT 25
`;

/** Seat purchases, which never produce a Stripe invoice and so never land in
 *  the payment ledger. `account_seats` is the only record they have. */
export const SEATS_BY_ACCOUNT = `
  SELECT account_id AS user_id, COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents
  FROM account_seats
  GROUP BY account_id
`;

/**
 * Normalise a price to what it is worth in a month.
 *
 * Stripe gives an interval and a count — `year`/1 and `month`/12 are the same
 * money — so everything is reduced to a month before it can be added up. A
 * price with no recurrence is a one-off (a seat) and contributes nothing to a
 * recurring total.
 */
export function monthlyCents(price: {
    unit_amount?: number | null;
    recurring?: { interval?: string; interval_count?: number | null } | null;
} | null | undefined): number {
    const amount = price?.unit_amount ?? 0;
    const rec = price?.recurring;
    if (!amount || !rec?.interval) return 0;

    const count = rec.interval_count && rec.interval_count > 0 ? rec.interval_count : 1;
    const monthsPerPeriod =
        rec.interval === "year" ? 12 * count
        : rec.interval === "month" ? count
        : rec.interval === "week" ? count / 4.345
        : rec.interval === "day" ? count / 30.44
        : 0;

    if (!monthsPerPeriod) return 0;
    return amount / monthsPerPeriod;
}
