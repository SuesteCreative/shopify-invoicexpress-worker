-- Reconciliation: customer-facing Shopify ↔ IX match overrides

CREATE TABLE IF NOT EXISTS reconciliation_match (
  shopify_domain TEXT NOT NULL,
  order_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT NOT NULL,
  PRIMARY KEY (shopify_domain, order_id)
);

CREATE TABLE IF NOT EXISTS reconciliation_decision (
  shopify_domain TEXT NOT NULL,
  order_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  decided_by TEXT,
  decided_at TEXT NOT NULL,
  PRIMARY KEY (shopify_domain, order_id)
);

CREATE INDEX IF NOT EXISTS idx_recon_match_shop ON reconciliation_match(shopify_domain);
CREATE INDEX IF NOT EXISTS idx_recon_decision_shop ON reconciliation_decision(shopify_domain);
