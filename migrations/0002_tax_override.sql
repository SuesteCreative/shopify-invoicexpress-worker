-- Per-account tax overrides for Dev Mode

ALTER TABLE integrations ADD COLUMN force_tax_rate REAL;
ALTER TABLE integrations ADD COLUMN oss_enabled INTEGER DEFAULT 1;
