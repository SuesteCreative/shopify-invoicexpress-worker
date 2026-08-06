-- Why a created document must NOT be auto-finalized or emailed to the customer.
--
-- Portuguese shoppers type their NIF into the checkout's "Apartamento, andar…"
-- box (address line 2) because most PT shop owners relabel that field "NIF".
-- When what lands there is a real, checksum-valid contribuinte we stamp it on
-- the invoice. When it is something else that was clearly *meant* to be a tax
-- id (a 9-digit run that fails the mod-11 check, an EU-prefixed VAT that does
-- not validate), neither available outcome is acceptable on its own: issuing
-- with the number puts a wrong contribuinte on a certified document, and
-- silently dropping it hands the customer an invoice without the NIF they
-- asked for.
--
-- So the document is still created — as a draft — and left there for a human.
-- This column records why, so `orders/paid` (which finalizes later, in a
-- separate webhook) knows to leave it alone, and so the merchant email can
-- name the reason. NULL = no hold, the overwhelming majority of rows.
--
-- Cleared automatically on re-emit: saveProcessedInvoice does INSERT OR REPLACE
-- and only writes a reason when the new build still has one.
ALTER TABLE processed_orders ADD COLUMN hold_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_processed_orders_hold
  ON processed_orders (hold_reason) WHERE hold_reason IS NOT NULL;
