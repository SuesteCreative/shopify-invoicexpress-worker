-- Stripe Subscription: Kapta Integrator billing
-- Tracks per-user subscription state + charge events with IX invoice matching

CREATE TABLE IF NOT EXISTS subscriptions (
  user_id TEXT PRIMARY KEY,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  status TEXT NOT NULL,                  -- trialing|active|past_due|canceled|incomplete|unpaid|incomplete_expired
  plan TEXT,                              -- 'monthly' | 'annual'
  price_id TEXT,                          -- Stripe price ID
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
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS billing_events (
  id TEXT PRIMARY KEY,                    -- Stripe event id (idempotency)
  user_id TEXT,
  type TEXT NOT NULL,                     -- invoice.paid | invoice.payment_failed | ...
  stripe_object_id TEXT,                  -- in_xxx (invoice id)
  payment_intent_id TEXT,                 -- pi_xxx
  amount_cents INTEGER,
  currency TEXT,
  status TEXT,                            -- paid|open|void|uncollectible|failed
  ix_invoice_id TEXT,                     -- IX doc id on Kapta's IX account after match
  ix_invoice_permalink TEXT,              -- direct link to IX document
  ix_match_method TEXT,                   -- 'reference' | 'heuristic' | null (pending)
  ix_match_score INTEGER,                 -- heuristic score 0..100
  raw_json TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_billing_user ON billing_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_pi   ON billing_events(payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_billing_pending ON billing_events(ix_invoice_id) WHERE ix_invoice_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_subs_status  ON subscriptions(status);

-- Note: early bird backfill lives in 0005b_early_bird_backfill.sql
-- (separate file because it depends on the `users` table which may not exist on fresh local DBs)
