-- Stripe Connect onboarding guards: the tax probe and the supervised run-in.
--
-- Two things a `stripe_connect` connection could not say about itself:
--
-- 1. Whether the merchant's Stripe account actually charges tax. The flag that
--    decides it, `stripe_tax_from_source`, is born 0, and with it at 0 a
--    `payment_intent.succeeded` normalizes to a single 0% line. A merchant who
--    collects 23% through Stripe was therefore invoiced at 0% with an exemption
--    nobody chose. The probe reads the account and writes the flag from
--    evidence; the verdict is kept here so the daily re-probe knows what it
--    already concluded and an operator can see it without re-running anything.
--    Absence of tax is NOT a fault: art.53 and the M-code regimes are the
--    correct output for a lot of this fleet. The probe only reports a mismatch
--    between what the connection declares and what the payments show.
--
-- 2. Whether anyone has ever checked a document it issued. With
--    `auto_finalize=1` the very first event certifies, and a certified document
--    is AT-communicated and undoable only by credit note. These columns hold
--    the run-in: drafts until the merchant answers, one question, one reminder.
--
-- Nullable and additive, so a rollback leaves them inert. They are columns and
-- not JSON keys on `destination_config_json` because everything in that blob
-- has to be declared in FISCAL_CONFIG_KEYS (backoffice/src/lib/redact.ts) or it
-- is redacted on read and refused on write — a contract pinned by
-- src/services/connection-config-writable.test.ts. This is onboarding
-- bookkeeping, not fiscal configuration.
--
-- Apply by hand. NEVER `wrangler d1 migrations apply` on this database: its
-- ledger stopped at 0017 and applying would replay everything since.
--   npx wrangler d1 execute rioko-db --remote --file migrations/0050_stripe_connect_onboarding.sql

ALTER TABLE connections ADD COLUMN tax_probe_at TEXT;
ALTER TABLE connections ADD COLUMN tax_probe_verdict TEXT;

ALTER TABLE connections ADD COLUMN runin_token TEXT;
ALTER TABLE connections ADD COLUMN runin_token_expires_at TEXT;
ALTER TABLE connections ADD COLUMN runin_asked_at TEXT;
ALTER TABLE connections ADD COLUMN runin_reminded_at TEXT;
-- 'yes' | 'no' | NULL. NULL means the question has not been answered, which is
-- what holds finalization: silence is never taken as consent.
ALTER TABLE connections ADD COLUMN runin_answer TEXT;

-- The token arrives as a path segment on a public route, so the lookup is by
-- token alone and has to be indexed.
CREATE INDEX IF NOT EXISTS idx_connections_runin_token ON connections(runin_token);
