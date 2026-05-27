-- Phase 3: Explicit product-mapping table.
--
-- Lets merchants pair a Shopify variant / Stripe price with an existing
-- destination product (Moloni today; IX / Vendus extensible later) instead
-- of letting the worker auto-create one via the SKU-fallback pattern in
-- `MoloniDestination.ensureMoloniProduct`.
--
-- Lookup key on the source side is the same string the adapter derives
-- via `deriveProductReference(item)` — SKU verbatim, `RIOKO-VARIANT-<id>`,
-- `RIOKO-PRODUCT-<id>`, or `RIOKO-SHIPPING`. Keeping the same key shape
-- means the adapter does a single Map lookup before falling back.

CREATE TABLE IF NOT EXISTS product_mappings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,             -- 'shopify' | 'stripe'
  destination_kind TEXT NOT NULL,        -- 'moloni' (others later)
  source_reference TEXT NOT NULL,        -- output of deriveProductReference()
  destination_product_id INTEGER NOT NULL,
  destination_reference TEXT,            -- Moloni product `reference` (for display)
  destination_name TEXT,                 -- snapshot of Moloni product name at mapping time
  source_name TEXT,                      -- snapshot of source product name (Shopify title)
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_mappings_unique
  ON product_mappings(user_id, source_kind, destination_kind, source_reference);

CREATE INDEX IF NOT EXISTS idx_product_mappings_user
  ON product_mappings(user_id, destination_kind);
