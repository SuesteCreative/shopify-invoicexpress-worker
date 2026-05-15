-- Separate force tax for shipping lines

ALTER TABLE integrations ADD COLUMN force_shipping_tax_rate REAL;
