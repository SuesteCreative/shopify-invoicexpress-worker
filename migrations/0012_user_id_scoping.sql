-- Phase 4 — Stripe Dev Mode parity. Until now every per-merchant table was
-- keyed by `shopify_domain`. Stripe-only users (no shopify_domain on their
-- integrations row) have `shopify_domain = NULL` on every processed_orders /
-- dev_jobs / logs row the pipeline wrote, which makes them indistinguishable
-- from one another in admin queries. This migration adds a `user_id` column
-- that the runtime now populates alongside `shopify_domain`, backfills it
-- for existing Shopify rows by joining `integrations`, and recreates the two
-- tables whose `shopify_domain` was `NOT NULL` so Stripe writes are legal.

-- 1. processed_orders — column is already nullable, just add user_id + index.
ALTER TABLE processed_orders ADD COLUMN user_id TEXT;

UPDATE processed_orders
SET user_id = (
  SELECT i.user_id FROM integrations i WHERE i.shopify_domain = processed_orders.shopify_domain
)
WHERE shopify_domain IS NOT NULL AND user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_processed_orders_user
  ON processed_orders(user_id, source_kind);

-- 2. logs — same shape (shopify_domain already nullable).
ALTER TABLE logs ADD COLUMN user_id TEXT;

UPDATE logs
SET user_id = (
  SELECT i.user_id FROM integrations i WHERE i.shopify_domain = logs.shopify_domain
)
WHERE shopify_domain IS NOT NULL AND user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_logs_user ON logs(user_id);

-- 3. webhook_info — also gets user_id so Dev Mode webhooks tab works for Stripe.
ALTER TABLE webhook_info ADD COLUMN user_id TEXT;

UPDATE webhook_info
SET user_id = (
  SELECT i.user_id FROM integrations i WHERE i.shopify_domain = webhook_info.shopify_domain
)
WHERE shopify_domain IS NOT NULL AND user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_webhook_info_user_created
  ON webhook_info(user_id, created_at DESC);

-- 4. dev_jobs — recreate so `shopify_domain` becomes nullable and a `user_id`
--    column joins it. SQLite can't ALTER COLUMN to drop NOT NULL.
CREATE TABLE dev_jobs_new (
  id TEXT PRIMARY KEY,
  shopify_domain TEXT,
  user_id TEXT,
  type TEXT NOT NULL,
  params TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  results TEXT,
  triggered_by TEXT,
  reason TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

INSERT INTO dev_jobs_new (id, shopify_domain, user_id, type, params, status, summary, results, triggered_by, reason, started_at, finished_at)
SELECT dj.id, dj.shopify_domain, i.user_id, dj.type, dj.params, dj.status, dj.summary, dj.results, dj.triggered_by, dj.reason, dj.started_at, dj.finished_at
FROM dev_jobs dj
LEFT JOIN integrations i ON i.shopify_domain = dj.shopify_domain;

DROP TABLE dev_jobs;
ALTER TABLE dev_jobs_new RENAME TO dev_jobs;

CREATE INDEX IF NOT EXISTS idx_dev_jobs_shop_started ON dev_jobs(shopify_domain, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_dev_jobs_user_started ON dev_jobs(user_id, started_at DESC);

-- 5. pending_reverse_charge — recreate to (a) relax `shopify_domain NOT NULL`,
--    (b) add `user_id`, (c) swap the per-merchant uniqueness from
--    `(shopify_domain, order_id)` to `(user_id, order_id)` so Stripe rows with
--    no shopify_domain still get the same dedup guarantee.
CREATE TABLE pending_reverse_charge_new (
  id TEXT PRIMARY KEY,
  shopify_domain TEXT,
  user_id TEXT,
  order_id TEXT NOT NULL,
  vat_id TEXT NOT NULL,
  country_code TEXT NOT NULL,
  normalized_json TEXT NOT NULL,
  webhook_topic TEXT NOT NULL,
  webhook_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  next_retry_at TEXT NOT NULL,
  last_error TEXT,
  incident_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO pending_reverse_charge_new (id, shopify_domain, user_id, order_id, vat_id, country_code, normalized_json, webhook_topic, webhook_id, attempts, status, next_retry_at, last_error, incident_id, created_at, updated_at)
SELECT prc.id, prc.shopify_domain, i.user_id, prc.order_id, prc.vat_id, prc.country_code, prc.normalized_json, prc.webhook_topic, prc.webhook_id, prc.attempts, prc.status, prc.next_retry_at, prc.last_error, prc.incident_id, prc.created_at, prc.updated_at
FROM pending_reverse_charge prc
LEFT JOIN integrations i ON i.shopify_domain = prc.shopify_domain;

DROP TABLE pending_reverse_charge;
ALTER TABLE pending_reverse_charge_new RENAME TO pending_reverse_charge;

CREATE INDEX IF NOT EXISTS idx_pending_rc_retry
  ON pending_reverse_charge(status, next_retry_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_rc_user_order
  ON pending_reverse_charge(user_id, order_id);
