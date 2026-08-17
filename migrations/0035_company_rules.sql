-- Per-company operator rules: the quirks a merchant's account carries that the
-- code cannot infer, written down once instead of remembered.
--
-- NEVER run `wrangler d1 migrations apply` on this database. Its ledger stopped
-- at 0017 and applying would replay everything since. This file goes on by hand:
--   npx wrangler d1 execute rioko-db --remote --file migrations/0035_company_rules.sql

-- 1. The free-text notes.
--
-- Two kinds of knowledge were being carried in the operator's head. The first is
-- enforceable — "emit VAT-excluded", "série RVFR", "M05 not M01" — and belongs in
-- the config columns the worker already reads, never here; a note cannot change a
-- document. The second explains failures rather than causing them ("the IX plan
-- quota renews on the 5th", "this client refuses simplified invoices"), and had
-- nowhere to live at all, so it was re-derived from scratch at 3am every time.
--
-- That second kind is what this table holds, and its one consumer is the AI
-- triage prompt: a diagnosis that knows the company reads very differently from
-- one that does not. Keyed by user because a company's quirks span every
-- connection it owns, not one source→destination pair.
CREATE TABLE IF NOT EXISTS company_rules (
  user_id    TEXT PRIMARY KEY,
  notes      TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT
);

-- 2. A per-company note stamped onto the document itself.
--
-- Distinct from the above in the way that matters: this one is document content,
-- so it is enforced config and lives with the rest of it. On the legacy path that
-- means a column; connection-based clients carry the same key inside
-- `destination_config_json`, which needs no migration.
--
-- IX caps `observations` at 200 characters and the exemption mention is written
-- first (a legal mention that gets truncated is worse than none), so this takes
-- whatever room is left rather than pushing anything out.
ALTER TABLE integrations ADD COLUMN custom_invoice_note TEXT;

-- 3. Who changed which fiscal setting, and from what.
--
-- The console makes settings editable that previously required deliberate SQL,
-- and some of them decide the VAT on every subsequent document — force_tax_rate
-- is the field behind the Zoo de Lagos incident (81 tickets, €235.88 of IVA
-- undeclared). The emit-path guards catch a wrong value at emission; nothing
-- recorded how the value got there, so "was this always 6, or did someone change
-- it on Tuesday?" was unanswerable.
--
-- Deliberately NOT `document_events`: that table is the narrative of one sale,
-- keyed by external_id, and a config change belongs to a company rather than to
-- any document.
CREATE TABLE IF NOT EXISTS config_audit (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,   -- the company whose configuration changed
  actor      TEXT,            -- the admin who changed it
  scope      TEXT NOT NULL,   -- 'integrations' | 'connection:<source>-><dest>' | 'company_rules'
  field      TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_config_audit_user
  ON config_audit (user_id, created_at);
