-- Progressive (partial) invoicing for Lodgify bookings that are paid in
-- instalments (e.g. 50% deposit + 50% balance). One row per invoice issued for
-- a booking, so the poll knows how much has already been invoiced and can bill
-- only the newly-paid delta on the next payment. Gated per-connection by
-- destination_config_json.moloni_partial_invoicing; unset ⇒ old behaviour
-- (single invoice at 100% paid).
--
-- Additive/idempotent.

CREATE TABLE IF NOT EXISTS lodgify_partial_invoices (
  booking_id       TEXT NOT NULL,       -- Lodgify booking id
  user_id          TEXT NOT NULL,       -- owning connection user
  seq              INTEGER NOT NULL,    -- 1, 2, … order of the instalment invoice
  invoice_id       TEXT,                -- Moloni document_id issued for this instalment
  invoiced_amount  REAL NOT NULL,       -- gross amount billed by this instalment
  our_reference    TEXT,                -- "Order #<N>-<seq>" written to Moloni
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (booking_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_lodgify_partial_user_booking
  ON lodgify_partial_invoices(user_id, booking_id);
