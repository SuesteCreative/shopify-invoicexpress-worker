-- 0066 — one row per refund, so a credit note is issued once and only once.
--
-- Apply BY HAND:
--   npx wrangler d1 execute rioko-db --remote --file migrations/0066_credit_notes.sql
-- NEVER `d1 migrations apply` on this database: its ledger is stuck at 0017 and
-- applying would replay everything since.
--
-- WHY
-- The refund path's only defence against issuing the same credit note twice was
-- a remote read of InvoiceXpress's related documents — and that read's error was
-- discarded, so a failed read meant "this invoice has no credit notes yet". On
-- 2026-09-14 the Bikini Books refund webhook retried 42 times in an hour and the
-- same 15,00 € credit note was created 22 times: three of them reached final
-- state (45 € credited against a 57 € invoice), nineteen were left as drafts.
--
-- An answer this load-bearing cannot live at the other end of a network call.
-- The ledger is local, it records the OUTCOME and not just a lock, and it is
-- FAIL-CLOSED: a table we cannot read means "do not issue", every time, because
-- the alternative is a second certified fiscal document that only a human can
-- undo. Same doctrine as `claimSettlement`, and the opposite of `claimOrder`,
-- which fails open because an order that never invoices is the worse outcome
-- there.
--
-- `state` is the whole point of a table rather than a claim:
--   issuing  — we are mid-flight. Taken over only after 10 minutes, and NEVER
--              once `credit_note_id` is set, because then a document really does
--              exist at the destination.
--   issued   — done. Redeliveries are no-ops for ever.
--   refused  — the destination will never accept this one (a refund that cannot
--              be mirrored onto the invoice). An incident carries it to a human;
--              retrying only repeats the refusal.
--
-- The key is (scope, refund_id), never the invoice: a second refund against the
-- same invoice is legitimate and must still be credited. The only cross-refund
-- limit is one of VALUE, and that is `creditedTotalForInvoice`, not this key.
CREATE TABLE IF NOT EXISTS credit_notes (
  scope          TEXT NOT NULL,   -- user_id, or the shop domain when there is none
  refund_id      TEXT NOT NULL,
  invoice_id     TEXT NOT NULL,
  credit_note_id TEXT,
  amount         REAL,
  state          TEXT NOT NULL,   -- issuing | issued | refused
  claimed_at     TEXT NOT NULL,
  updated_at     TEXT,
  last_message   TEXT,
  PRIMARY KEY (scope, refund_id)
);

CREATE INDEX IF NOT EXISTS idx_credit_notes_invoice ON credit_notes (scope, invoice_id);

-- Seed from what we already know, so nothing credited before this deploy is
-- credited again the first time its webhook is redelivered. `document_events`
-- has written `credit_issued:<refundId>` under a UNIQUE key since 0034 — it is
-- a log and stays a log, but it is a true record of what was issued, and reading
-- it once here is the cheapest way to start the ledger already correct.
INSERT OR IGNORE INTO credit_notes
  (scope, refund_id, invoice_id, credit_note_id, amount, state, claimed_at, updated_at, last_message)
SELECT
  COALESCE(NULLIF(user_id, ''), NULLIF(shopify_domain, ''), ''),
  substr(dedup_key, 15),
  COALESCE(invoice_id, ''),
  json_extract(detail_json, '$.creditNoteId'),
  json_extract(detail_json, '$.amount'),
  'issued',
  created_at,
  created_at,
  'seeded from document_events by migration 0066'
FROM document_events
WHERE event = 'credit_issued' AND dedup_key LIKE 'credit_issued:%';
