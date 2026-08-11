-- One order, one document.
--
-- `handleOrderCreated` guarded itself with check-then-act: ask whether the
-- order is already processed, ask InvoiceXpress whether a document with its
-- reference exists, then create and record one. Two `orders/created`
-- deliveries for the same order land in different queue batches that overlap
-- across Worker invocations, so both read "not processed" before either writes,
-- and both create a document. Measured on Salted Books: 60 orphan duplicate
-- drafts, ids consecutive, created seconds apart. The reference lookup does not
-- save it either — a just-created IX document is not immediately findable by
-- reference, which is why the paid path already pads with awaitInvoiceVisibility.
--
-- This table turns that check-then-act into a compare-and-swap. A worker claims
-- the order with INSERT OR IGNORE and only proceeds if it won the row; the
-- loser stops before creating anything. The claim is released as soon as the
-- outcome is durable in processed_orders, so it is a lock held for seconds, not
-- a second source of truth.
--
-- `claimed_at` exists so a claim cannot outlive the worker that took it: if an
-- invocation dies between claiming and recording, the next delivery takes the
-- claim over once it is stale rather than leaving the order uninvoiced forever.
CREATE TABLE IF NOT EXISTS order_claims (
  shopify_domain TEXT NOT NULL,
  order_id       TEXT NOT NULL,
  claimed_at     TEXT NOT NULL,
  PRIMARY KEY (shopify_domain, order_id)
);

CREATE INDEX IF NOT EXISTS idx_order_claims_claimed_at ON order_claims (claimed_at);
