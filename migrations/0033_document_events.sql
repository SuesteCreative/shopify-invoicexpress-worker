-- The life of one document, in order, in words.
--
-- Answering "what happened to this invoice?" currently means joining
-- processed_orders (did we record one), the per-shop log (what the webhook
-- topic returned), the document at the destination (what it actually says), and
-- git history (what the code did that day). Two investigations on 2026-08-14/15
-- ran that way and each took hours: the "Order #0" reference collision, where
-- every Stripe sale shared one reference and only the first was billed, and
-- lliberta 11/LL, where we sent exemption code M10 and InvoiceXpress stored M99.
--
-- Both were silent. Nothing failed, nothing retried, no counter moved. They were
-- found because a merchant counted their own invoices.
--
-- This table is the missing narrative: one row per thing that happened to one
-- document, in Portuguese, including the things that went RIGHT. A log that only
-- records failures cannot tell you that a document was verified against the
-- destination and matched — and that confirmation is what makes the absence of a
-- drift row meaningful.
--
-- It is a log, not state. `processed_orders` remains the answer to "is this
-- order billed"; nothing reads its truth from here.
CREATE TABLE IF NOT EXISTS document_events (
  id             TEXT PRIMARY KEY,
  -- Thread key. The sale, always known — even when creation failed and there is
  -- no document id to hang the row off yet.
  external_id    TEXT NOT NULL,      -- Shopify order id, Stripe pi_…, Lodgify booking id
  user_id        TEXT,
  shopify_domain TEXT,
  source_kind    TEXT,               -- shopify | stripe | lodgify | eupago
  destination_kind TEXT,             -- invoicexpress | moloni | vendus
  -- Null until the destination hands one back: a `build_failed` row precedes any
  -- document existing, and is exactly the case worth reading later.
  invoice_id     TEXT,
  event          TEXT NOT NULL,      -- see document-log.ts EVENT_LABELS
  severity       TEXT NOT NULL DEFAULT 'info',   -- info | warning | error
  -- One human sentence, European Portuguese, written for someone reading this
  -- months later with no context: what happened, to what, with which values.
  summary        TEXT NOT NULL,
  -- Structured payload behind the sentence (sent vs stored, the platform's own
  -- error body, the fields compared). Never secrets.
  detail_json    TEXT,
  -- Who caused it: 'pipeline' | 'sweep' | 'admin:<name>' | 'cron:<name>'.
  actor          TEXT,
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The read that matters: one sale's whole story, oldest first.
CREATE INDEX IF NOT EXISTS idx_document_events_external
  ON document_events (external_id, created_at);

-- "Show me every drift this week", and the per-merchant view behind it.
CREATE INDEX IF NOT EXISTS idx_document_events_user_event
  ON document_events (user_id, event, created_at);

-- Reverse lookup from a document number someone is holding in their hand.
CREATE INDEX IF NOT EXISTS idx_document_events_invoice
  ON document_events (invoice_id);
