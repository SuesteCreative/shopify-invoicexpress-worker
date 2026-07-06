-- Stamp the VAT-exemption legal mention into invoice observations (opt-in per shop).
--
-- When on, an invoice whose exemption code is applied (any 0%-tax line, non
-- reverse-charge) also carries the human-readable bilingual mention for that
-- code in `observations` — e.g. M05 → "Isento de IVA ao abrigo do art.º 14.º do
-- CIVA | VAT exempt under Article 14 of the Portuguese VAT Code (CIVA)". IX
-- otherwise only renders its own PT-only text from the M-code; carriers/customs
-- (e.g. UPS on US exports) need the exemption spelled out on the document.
--
-- The mention text is DERIVED from the shop's configured ix_exemption_reason
-- (see src/ix/exemption-mentions.ts), not hardcoded per client. Reverse-charge
-- invoices keep their own dedicated mention and are unaffected.
--
-- DEFAULT 0 = off for every shop. Enable per shop:
--   UPDATE integrations SET ix_stamp_exemption_note = 1 WHERE shopify_domain = '...';

ALTER TABLE integrations ADD COLUMN ix_stamp_exemption_note INTEGER DEFAULT 0;
