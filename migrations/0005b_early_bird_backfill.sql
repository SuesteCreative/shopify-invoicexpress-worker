-- Early bird backfill: every existing user gets a trial until 2026-08-01
-- Run ONLY against environments where `users` table exists (e.g. --remote).
-- Idempotent: re-running does not re-trial users who already subscribed (PK conflict ignored).
INSERT OR IGNORE INTO subscriptions (user_id, status, trial_end, early_bird, created_at, updated_at)
SELECT id, 'trialing', '2026-08-01T00:00:00Z', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM users;
