-- Per-SKU overrides for the InvoiceXpress destination path.
--
-- IX accepts ad-hoc invoice lines (no product_id required) so we don't need
-- a Moloni-style mapping table. What merchants DO need is per-SKU overrides
-- for cases where Shopify's order data doesn't match reality:
--
--   tax_rate          — override the inferred VAT rate (e.g. force 6% on
--                       books even if Shopify reports 23%)
--   vat_inclusion     — override the order-level `taxes_included` flag for
--                       this specific SKU. Some merchants have Shopify
--                       sending tax-excluded products with the included
--                       flag set; this lets them flip per-product.
--   exemption_reason  — per-product M-code (M07 for medical, M16 RITI, …)
--                       overrides the integration-level default.
--   name_override     — display name on the IX invoice line, replacing the
--                       Shopify title (cosmetic).
--
-- Source side identification follows the Moloni adapter's
-- `deriveProductReference()` so the same source_reference string works
-- across destinations.

CREATE TABLE IF NOT EXISTS product_overrides (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,            -- 'shopify' | 'stripe'
  destination_kind TEXT NOT NULL,       -- 'invoicexpress' (later: 'vendus')
  source_reference TEXT NOT NULL,
  tax_rate REAL,                        -- null = use Shopify-reported rate
  vat_inclusion TEXT,                   -- 'inc' | 'exc' | null
  exemption_reason TEXT,                -- null = use integration default
  name_override TEXT,                   -- null = use Shopify title
  source_name TEXT,                     -- snapshot for the UI list
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_overrides_unique
  ON product_overrides(user_id, source_kind, destination_kind, source_reference);

CREATE INDEX IF NOT EXISTS idx_product_overrides_user
  ON product_overrides(user_id, destination_kind);
