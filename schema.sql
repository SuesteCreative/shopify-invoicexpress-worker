-- Rioko 2.0 Database Schema
CREATE TABLE IF NOT EXISTS integrations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    shopify_domain TEXT,
    shopify_token TEXT,
    shopify_webhook_secret TEXT,
    ix_account_name TEXT,
    ix_api_key TEXT,
    vat_included INTEGER DEFAULT 1,
    auto_finalize INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_id ON integrations(user_id);
