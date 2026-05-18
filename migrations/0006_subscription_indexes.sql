-- Index for resolveUserIdFromCustomer (Stripe webhook hot path)
CREATE INDEX IF NOT EXISTS idx_subs_customer ON subscriptions(stripe_customer_id);
