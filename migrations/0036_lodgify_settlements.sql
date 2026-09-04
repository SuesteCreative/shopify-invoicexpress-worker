-- Which Lodgify invoices are worth asking Moloni about.
--
-- Every number in here is a CACHED COPY of an answer Moloni or Lodgify already
-- gave, and it decides ONE thing: whether a document is worth a round trip on
-- this pass. The amount actually receipted is never read from here — it comes
-- from a live `reconciled_value` inside `settleDocument`, so a stale row can
-- cost a wasted read or a late Recibo, never a wrong one.
--
-- Without it the settlement pass re-reads every document the merchant has ever
-- been invoiced for, every half hour: ~480 Moloni reads a day for the two
-- receipts a month this actually issues, growing with billing HISTORY rather
-- than with payments.
--
-- `needs_human` is the latch. It lives here and not on `processed_orders`
-- because `saveProcessedInvoice` is INSERT OR REPLACE over a fixed column list,
-- so a routine re-save would silently clear it — and a poison pill a re-save can
-- clear is not a poison pill.
--
-- Apply by hand:
--   npx wrangler d1 execute rioko-db --remote --file migrations/0036_lodgify_settlements.sql
-- NEVER `d1 migrations apply` on this database: its ledger is stuck at 0017 and
-- it would replay 0018+ onto columns that already exist.

CREATE TABLE IF NOT EXISTS lodgify_settlements (
  user_id          TEXT NOT NULL,
  booking_id       TEXT NOT NULL,
  invoice_id       TEXT NOT NULL,
  -- Moloni's own state at the last look: 0 draft, 1 closed.
  doc_status       INTEGER,
  doc_total        REAL,
  -- What Lodgify said had come in when we last asked, and what Moloni said was
  -- reconciled. A candidate is worth a read when these two disagree.
  last_collected   REAL,
  last_settled     REAL,
  last_receipt_id  TEXT,
  -- 1 = stop asking, a human must look. Set when a Recibo was accepted and the
  -- document did not reconcile, or when a guard refused the document outright.
  needs_human      INTEGER NOT NULL DEFAULT 0,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_checked_at  TEXT,
  -- Cooldown for a document that is legitimately not ready — a draft awaiting
  -- the merchant's approval must not cost 48 reads a day while it waits.
  next_check_at    TEXT,
  last_message     TEXT,
  PRIMARY KEY (user_id, booking_id, invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_lodgify_settlements_next
  ON lodgify_settlements (user_id, next_check_at);
