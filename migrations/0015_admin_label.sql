-- Admin-only human label for a store/user, set from the superadmin list.
--
-- Stores onboarded via Shopify before completing fiscal registration have a
-- NULL company_name and surface only their cryptic *.myshopify.com domain
-- (e.g. 2d0604-3) — impossible to recognise at a glance. This column lets a
-- superadmin pin a readable name (e.g. "Angel Piercings") for IDENTIFICATION
-- ONLY.
--
-- It never feeds InvoiceXpress / fiscal documents — that path keeps using
-- company_name. UI display precedence: admin_label > company_name > domain.

ALTER TABLE users ADD COLUMN admin_label TEXT;
