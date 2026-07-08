-- Re-assert "Shopify = early-bird by default" in the DB (single source of truth).
-- Migration 0022 was a one-shot that ran only over rows existing at the time, and
-- the Clerk seed always writes early_bird=0, so Shopify merchants onboarded after
-- 0022 end up early_bird=0 and are wrongly gated as blocked. Set early_bird=1 (and
-- a trial_end grace cutoff if missing) for every Shopify merchant — a user with a
-- shopify connection OR a legacy integrations row. Non-Shopify users untouched.
UPDATE subscriptions
SET early_bird = 1,
    trial_end = COALESCE(trial_end, '2026-08-01T00:00:00Z'),
    updated_at = CURRENT_TIMESTAMP
WHERE early_bird = 0
  AND (
    user_id IN (SELECT user_id FROM connections WHERE source_kind = 'shopify')
    OR user_id IN (SELECT user_id FROM integrations)
  );
