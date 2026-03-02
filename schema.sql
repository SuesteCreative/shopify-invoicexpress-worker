-- Rioko 2.0 Database Schema
CREATE TABLE IF NOT EXISTS integrations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    shopify_domain TEXT,
    shopify_token TEXT,
    shopify_webhook_secret TEXT,
    shopify_api_version TEXT DEFAULT '2026-01',
    ix_account_name TEXT,
    ix_api_key TEXT,
    ix_environment TEXT DEFAULT 'production',
    ix_exemption_reason TEXT DEFAULT 'M01',
    vat_included INTEGER DEFAULT 1,
    auto_finalize INTEGER DEFAULT 0,
    webhooks_active INTEGER DEFAULT 0,
    ix_document_type TEXT DEFAULT 'invoice_receipt',
    ix_payment_term INTEGER DEFAULT 0,
    ix_sequence_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_id ON integrations(user_id);

CREATE TABLE IF NOT EXISTS logs (
    id TEXT PRIMARY KEY,
    shopify_domain TEXT,
    topic TEXT,
    payload TEXT,
    response TEXT,
    status INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS processed_orders (
    id TEXT PRIMARY KEY, -- shopify_order_id or refund_id
    invoice_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_processed_orders_id ON processed_orders(id);
