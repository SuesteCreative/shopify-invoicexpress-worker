-- One subscription per connection, instead of one per account.
--
-- `subscriptions.user_id` was the PRIMARY KEY, so an account could hold exactly
-- one subscription no matter how many integrations it ran. Both gates — the
-- worker's `checkSubscriptionGate` and the backoffice's `isSubscriptionBlocked`
-- — ask only for the user, so a second integration invoiced for free on the
-- first one's subscription. Measured on Wim Hof Method (08/09/2026): a Shopify
-- shop live on a subscription bought for a Stripe account.
--
-- The price was already per integration (checkout picks a different Stripe
-- price per source); only the row and the gate were not.
--
-- `connection_key` is `<source_kind>:<destination_kind>` — the same string the
-- checkout route already maps to a price. The legacy Shopify integration has no
-- `connections` row and never will until that backfill happens, so its key is
-- the default: it names the pair, not a row.
--
-- Backfill attaches each existing subscription to the connection the account set
-- up FIRST, which is what it was bought for. Where an account has since added a
-- second connection, that one comes out uncovered — which is the point, and why
-- enforcement ships behind SUBSCRIPTION_PER_CONNECTION rather than switching on
-- with this migration.

CREATE TABLE subscriptions_new (
  user_id TEXT NOT NULL,
  connection_key TEXT NOT NULL DEFAULT 'shopify:invoicexpress',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  status TEXT NOT NULL,
  plan TEXT,
  price_id TEXT,
  current_period_end TEXT,
  trial_end TEXT,
  cancel_at_period_end INTEGER DEFAULT 0,
  early_bird INTEGER DEFAULT 0,
  nif TEXT,
  name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  zip TEXT,
  country TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  renewal_reminder_sent_for TEXT,
  early_bird_reminder_sent_for TEXT,
  admin_override_at TEXT,
  paused_notice_sent_at TEXT,
  PRIMARY KEY (user_id, connection_key)
);

INSERT INTO subscriptions_new (
  user_id, connection_key, stripe_customer_id, stripe_subscription_id, status,
  plan, price_id, current_period_end, trial_end, cancel_at_period_end, early_bird,
  nif, name, email, phone, address, city, zip, country, created_at, updated_at,
  renewal_reminder_sent_for, early_bird_reminder_sent_for, admin_override_at, paused_notice_sent_at
)
SELECT
  s.user_id,
  -- The oldest connection wins, and a Shopify shop older than any of them wins
  -- over those: it is the integration the subscription was bought for.
  CASE
    WHEN EXISTS (
      SELECT 1 FROM integrations i
       WHERE i.user_id = s.user_id
         AND i.shopify_domain IS NOT NULL AND i.shopify_domain <> ''
         AND i.created_at <= COALESCE((SELECT MIN(c.created_at) FROM connections c WHERE c.user_id = s.user_id), i.created_at)
    ) THEN 'shopify:invoicexpress'
    ELSE COALESCE(
      (SELECT c.source_kind || ':' || c.destination_kind
         FROM connections c WHERE c.user_id = s.user_id
        ORDER BY c.created_at ASC LIMIT 1),
      'shopify:invoicexpress')
  END,
  s.stripe_customer_id, s.stripe_subscription_id, s.status,
  s.plan, s.price_id, s.current_period_end, s.trial_end, s.cancel_at_period_end, s.early_bird,
  s.nif, s.name, s.email, s.phone, s.address, s.city, s.zip, s.country, s.created_at, s.updated_at,
  s.renewal_reminder_sent_for, s.early_bird_reminder_sent_for, s.admin_override_at, s.paused_notice_sent_at
FROM subscriptions s;

DROP TABLE subscriptions;
ALTER TABLE subscriptions_new RENAME TO subscriptions;

-- The webhook finds a row by the Stripe ids it is handed, before it knows which
-- connection the event belongs to.
CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub ON subscriptions(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
