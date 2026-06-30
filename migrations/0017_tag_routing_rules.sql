-- Tag-based invoice routing: route orders to a specific IX series / document type
-- when the source payload contains a matching tag (Shopify order tag) or
-- metadata entry (Stripe metadata key:value).
CREATE TABLE tag_routing_rules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,       -- 'shopify' | 'stripe' | 'eupago'
  destination_kind TEXT NOT NULL,  -- 'invoicexpress'
  tag_name TEXT NOT NULL,          -- exact string to match (e.g. "property_id:686585")
  document_type TEXT,              -- 'invoice' | 'invoice_receipt' | NULL (use integration default)
  series_name TEXT,                -- IX sequence serie code e.g. 'RVFR' | NULL (use default)
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One rule per (user, source, destination, tag). Upsert key.
CREATE UNIQUE INDEX idx_tag_routing_unique
  ON tag_routing_rules(user_id, source_kind, destination_kind, tag_name);

CREATE INDEX idx_tag_routing_user
  ON tag_routing_rules(user_id, destination_kind);
