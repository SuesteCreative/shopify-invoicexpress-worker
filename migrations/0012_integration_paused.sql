-- Adds a per-integration pause switch.
--
-- When `is_paused = 1`, every webhook handler and the adapter pipeline must
-- log + return without touching the destination (InvoiceXpress / Moloni).
-- The user toggles it from the integration detail page; the worker honours
-- it on the next event without requiring a webhook re-subscription.

ALTER TABLE integrations ADD COLUMN is_paused INTEGER DEFAULT 0;
