-- Newsletter opt-outs, ours since the newsletter stopped being a Resend
-- Broadcast (13/09/2026) and Resend stopped holding the unsubscribe state.
--
-- One row per address that pressed "Cancelar subscrição" on the signed link, or
-- the inbox's one-click unsubscribe. resolveAudience (backoffice) leaves these
-- addresses out of every newsletter, picked by hand or typed in included.
-- Transactional mail (incidents, dunning, renewals) never reads this table, the
-- same contract migration 0046 states for parked accounts.
--
-- Apply by hand, BEFORE the code that reads it is deployed (resolveAudience
-- queries it on every simulation):
--   npx wrangler d1 execute rioko-db --remote --file migrations/0060_newsletter_optouts.sql
-- NEVER `d1 migrations apply` on this database: its ledger is stuck at 0017.

CREATE TABLE IF NOT EXISTS newsletter_optouts (
  email      TEXT PRIMARY KEY,                     -- lowercased, as signed
  source     TEXT,                                 -- 'link' | 'one-click'
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
