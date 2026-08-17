-- Hardening `document_events`. Additive only: the table is live and the deployed
-- Worker is writing to it, so every statement here must be safe to run against a
-- table that is being appended to at the same time.
--
-- NEVER run `wrangler d1 migrations apply` on this database. Its ledger stopped
-- at 0017 and applying would replay everything since. This file goes on by hand:
--   npx wrangler d1 execute rioko-db --remote --file migrations/0034_...sql

-- 1. Idempotency.
--
-- A re-delivered webhook re-runs the work and writes the event again, so a sale
-- ends up with three "conferido" rows and the timeline reads like something
-- happened three times. Events that must happen at most once carry a natural
-- key; everything else leaves it NULL and may repeat freely.
--
-- The UNIQUE index is what enforces it, via INSERT OR IGNORE. SQLite treats
-- NULLs as distinct from each other in a unique index, so any number of rows may
-- have no key at all — which is exactly the "may repeat" half of the rule.
ALTER TABLE document_events ADD COLUMN dedup_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_document_events_dedup
  ON document_events (dedup_key);

-- 2. Say when the detail was cut.
--
-- `detail_json` is truncated at a fixed size, silently. The one time it matters
-- is when the payload you need is the part that got cut, and today nothing tells
-- you that happened — you read a JSON fragment and assume it is the whole thing.
ALTER TABLE document_events ADD COLUMN detail_truncated INTEGER NOT NULL DEFAULT 0;

-- 3. Make the retention purge cheap.
--
-- The existing indexes all lead with another column, so `WHERE created_at < ?`
-- scans the whole table. At ~23k rows a month that is a full scan every night,
-- growing, inside the daily cron's budget.
CREATE INDEX IF NOT EXISTS idx_document_events_created
  ON document_events (created_at);
