-- Retenção na fonte (Portuguese IRS/IRC withholding tax).
--
-- Adds an opt-in toggle + percentage value per shop, applied to the
-- invoice-level `retention` field on every IX document created for that shop.
-- The toggle and value are stored separately so users can switch the feature
-- off without losing their last picked percentage.

ALTER TABLE integrations ADD COLUMN ix_retention_enabled INTEGER DEFAULT 0;
ALTER TABLE integrations ADD COLUMN ix_retention REAL DEFAULT NULL;
