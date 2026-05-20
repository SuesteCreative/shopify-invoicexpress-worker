-- Phase 3: Stripe source adapter support.
--
-- Stripe refund handling needs to look up invoices by destination invoice id
-- (the IX id we wrote when the charge succeeded). Existing access patterns
-- on `processed_orders` use `id` (Shopify order id) as the lookup key; we now
-- need the reverse direction.

CREATE INDEX IF NOT EXISTS idx_processed_orders_invoice_id
  ON processed_orders(invoice_id);
