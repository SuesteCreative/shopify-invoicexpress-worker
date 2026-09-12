-- Newsletters: the template, and the record of what was actually sent.
--
-- Every email Rioko sends today is a reaction — an incident, a dunning notice, a
-- renewal reminder — fired by a cron. There is no way to write something and
-- send it. The three newsletters that were written (Claude outputs/) were never
-- sent, because sending them meant curl and a hand-built recipient list, which
-- is exactly the failure the dunning card was built to end: afterwards nobody
-- can say who received what, on which filters, or whether the list was the one
-- intended.
--
-- `newsletter_campaigns` is an audit row, not a queue. It is written AFTER
-- Resend answers, and it stores the resolved recipient list verbatim next to the
-- filters that produced it. The filters are a DESCRIPTION of an audience; the
-- snapshot is the audience. Re-running the same filters a week later returns a
-- different set — accounts sign up, subscriptions lapse, trials end — so a
-- campaign that kept only its filters could never answer "who got this".
--
-- No opt-out column here on purpose. Resend owns the unsubscribe state (global
-- to the contact, and scoped to Broadcasts only, so service mail is unaffected).
-- A second opt-out list in D1 would be a second source of truth and the first to
-- drift out of step with the one the unsubscribe link actually writes to.
--
-- Apply by hand:
--   npx wrangler d1 execute rioko-db --remote --file migrations/0056_newsletter.sql
-- NEVER `d1 migrations apply` on this database: its ledger is stuck at 0017 and
-- it would replay 0018+ onto columns that already exist.

CREATE TABLE newsletter_templates (
  slug         TEXT PRIMARY KEY,     -- 'convite', 'clientes', ...
  name         TEXT NOT NULL,
  subject      TEXT NOT NULL,
  preview_text TEXT,                 -- the line the inbox shows after the subject
  html         TEXT NOT NULL,        -- with {{OUR_VARS}} and {{{RESEND_TAGS}}} intact
  updated_by   TEXT,
  updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE newsletter_campaigns (
  id              TEXT PRIMARY KEY,  -- crypto.randomUUID()
  slug            TEXT NOT NULL,     -- the template it came from
  subject         TEXT NOT NULL,
  filters_json    TEXT NOT NULL,     -- exactly what the operator chose
  recipients_json TEXT NOT NULL,     -- the resolved snapshot, addresses only
  recipients      INTEGER NOT NULL,
  segment_id      TEXT,              -- Resend segment this went to
  broadcast_id    TEXT,              -- Resend broadcast id, for opens and clicks
  topic_id        TEXT,
  scheduled_at    TEXT,              -- NULL when sent immediately
  sent_by         TEXT NOT NULL,     -- Clerk id of whoever pressed send
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_newsletter_campaigns_created ON newsletter_campaigns(created_at DESC);
