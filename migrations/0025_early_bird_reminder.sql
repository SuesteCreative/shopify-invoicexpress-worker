-- Idempotency marker for the "early-bird grace is ending" reminder email.
-- Set to the sub's trial_end once the reminder is sent, so the daily sweep emails
-- each early-bird client at most once per grace cutoff.
ALTER TABLE subscriptions ADD COLUMN early_bird_reminder_sent_for TEXT;
