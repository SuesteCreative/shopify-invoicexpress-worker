-- Phase 2: Additive scaffolding for multi-source/multi-destination integrations.
--
-- Introduces the `connections` table that will eventually replace the single
-- `integrations` row per user with a tuple of (user, source, destination).
-- Phase 2 only creates the schema; runtime code still reads `integrations`.
--
-- Backward-compat: every ALTER below is nullable. NULL source_kind / destination_kind
-- in legacy rows is read as ("shopify", "invoicexpress") by app code.

CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  destination_kind TEXT NOT NULL,
  source_config_json TEXT,
  destination_config_json TEXT,
  behavior_json TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_connections_user_pair
  ON connections(user_id, source_kind, destination_kind);

CREATE INDEX IF NOT EXISTS idx_connections_user_status
  ON connections(user_id, status);

ALTER TABLE processed_orders ADD COLUMN source_kind TEXT;
ALTER TABLE processed_orders ADD COLUMN destination_kind TEXT;

CREATE INDEX IF NOT EXISTS idx_processed_orders_source
  ON processed_orders(source_kind, id);

ALTER TABLE webhook_info ADD COLUMN source_kind TEXT;
