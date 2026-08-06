-- Per-shop reconciliation-sweep bookkeeping.
--
-- The sweep has a wall-clock budget and breaks out of the shop loop when it is
-- spent. Until now that break was invisible: a shop that never got its turn
-- looked exactly like a shop with nothing to heal, which is how Zoo de Lagos
-- accumulated 75 uninvoiced orders while the cron reported success every night.
--
-- Recording when each shop last *completed* a pass makes the gap queryable, so
-- a shop starved for more than a day raises an incident instead of going quiet.
CREATE TABLE IF NOT EXISTS sweep_state (
  shopify_domain    TEXT PRIMARY KEY,
  last_started_at   TEXT,
  last_completed_at TEXT,
  last_status       TEXT,   -- 'ok' | 'error' | 'skipped_budget'
  last_detail_json  TEXT
);

CREATE INDEX IF NOT EXISTS idx_sweep_state_completed ON sweep_state (last_completed_at);
