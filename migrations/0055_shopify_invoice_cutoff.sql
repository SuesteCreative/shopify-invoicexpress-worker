-- A cutoff for the legacy Shopify->InvoiceXpress integrations.
--
-- `connections` has had `invoice_cutoff` since the connection-based sources
-- arrived, and every reader treats it the same way: sales paid BEFORE the date
-- Rioko took the integration over were never ours to issue, because the
-- merchant's previous process already owned them. The legacy Shopify row never
-- had the column, so `resolveConnectionContext` handed those integrations
-- `invoiceCutoff: null` and every Shopify path behaved as if the merchant's
-- whole back-catalogue were ours.
--
-- What that costs, measured on WHM (Wim Hof Plunge, 12/09/2026): the five
-- August orders the merchant had already invoiced BY HAND into WH-25-1
-- (1446-1450, 7.735,30 EUR) showed up as "por facturar" on the Conciliação
-- page, and any 90-day drain would have minted a duplicate of each one. The
-- nightly sweep's 3-day window hid the risk rather than removing it: a shop
-- that onboards today with orders from yesterday is inside that window.
--
-- Backfill = `created_at`, the day the integration was set up, which is the
-- same fallback `connections` already applies (`invoice_cutoff ?? created_at`).
-- SQLite writes CURRENT_TIMESTAMP as "YYYY-MM-DD HH:MM:SS" with no zone, and it
-- is UTC, so it is normalised to ISO here rather than at each of the readers
-- that call Date.parse on it.
--
-- Apply by hand:
--   npx wrangler d1 execute rioko-db --remote --file migrations/0055_shopify_invoice_cutoff.sql
-- NEVER `d1 migrations apply` on this database: its ledger is stuck at 0017 and
-- it would replay 0018+ onto columns that already exist.
ALTER TABLE integrations ADD COLUMN invoice_cutoff TEXT;

UPDATE integrations
   SET invoice_cutoff = replace(created_at, ' ', 'T') || 'Z'
 WHERE invoice_cutoff IS NULL
   AND created_at IS NOT NULL
   AND created_at NOT LIKE '%Z'
   AND created_at NOT LIKE '%+%';

UPDATE integrations
   SET invoice_cutoff = created_at
 WHERE invoice_cutoff IS NULL
   AND created_at IS NOT NULL;
