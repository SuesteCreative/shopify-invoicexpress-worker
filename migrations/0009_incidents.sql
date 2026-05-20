-- Phase 4a.1: Incidents — proactive diagnostics primitive.
--
-- Every error site in the worker (pipeline catch blocks, queue retries,
-- subscription gate blocks, etc.) calls reportIncident() which upserts a row
-- here keyed by bucket_key. That groups N identical failures within the same
-- hour into ONE row with `occurrences=N`, preventing email floods.
--
-- The daily digest cron groups open + not-yet-notified incidents per user and
-- sends one email per merchant. Critical-severity rows email immediately.
--
-- Backward-compat: additive table. No code reads it on day 1 of deploy.

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  connection_id TEXT,
  -- bucket_key = "{user_id|none}:{kind}:{YYYY-MM-DD-HH}" — uniqueness key for upserts.
  bucket_key TEXT NOT NULL,
  severity TEXT NOT NULL,        -- 'info' | 'warning' | 'error' | 'critical'
  kind TEXT NOT NULL,            -- 'auth_failure_*' | 'destination_reject' | 'normalize_fail' | 'nif_invalid' | 'subscription_inactive' | 'queue_retry_exhausted' | 'webhook_invalid_signature'
  summary TEXT NOT NULL,
  detail_json TEXT,
  affected_ids_json TEXT,        -- JSON array of source-side IDs (order_id, payment_intent, etc.)
  status TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'acknowledged' | 'resolved' | 'auto_resolved'
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  notified_at TEXT,
  resolved_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_incidents_bucket ON incidents(bucket_key);

-- For the daily digest and the superadmin "open incidents" view.
CREATE INDEX IF NOT EXISTS idx_incidents_open_by_user
  ON incidents(user_id, status, severity, last_seen_at);

-- For the auto-resolve cron (incidents with last_seen_at > 24h stale).
CREATE INDEX IF NOT EXISTS idx_incidents_last_seen
  ON incidents(status, last_seen_at);
