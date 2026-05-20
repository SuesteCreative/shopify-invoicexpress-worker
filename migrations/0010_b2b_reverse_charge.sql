-- B2B reverse-charge for OSS shops.
--
-- Adds opt-in toggle + custom PT exemption code per shop, plus a pending queue
-- for orders whose VIES validation didn't return a definitive yes/no on the
-- first try. The cron retries those (15min, 1h) and after 3 failures opens an
-- incident asking the merchant to validate manually at viesvalidation.com.

ALTER TABLE integrations ADD COLUMN b2b_reverse_charge INTEGER DEFAULT 0;
ALTER TABLE integrations ADD COLUMN ix_b2b_exemption_reason TEXT DEFAULT 'M16';

CREATE TABLE IF NOT EXISTS pending_reverse_charge (
  id TEXT PRIMARY KEY,
  shopify_domain TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_pending_rc_retry
  ON pending_reverse_charge(status, next_retry_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_rc_order
  ON pending_reverse_charge(shopify_domain, order_id);
