-- Dev Mode infra: job audit log + per-account prefs + scope webhook_info per shop

CREATE TABLE IF NOT EXISTS dev_jobs (
  id TEXT PRIMARY KEY,
  shopify_domain TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_dev_jobs_shop_started ON dev_jobs(shopify_domain, started_at DESC);

ALTER TABLE integrations ADD COLUMN dev_notify_emails TEXT;

ALTER TABLE webhook_info ADD COLUMN shopify_domain TEXT;
ALTER TABLE processed_orders ADD COLUMN shopify_domain TEXT;
