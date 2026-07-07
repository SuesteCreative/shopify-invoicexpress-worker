-- Idempotency marker for subscription renewal reminders. Stores the
-- current_period_end value a reminder was already sent for, so the daily cron
-- sends exactly one reminder per period (and re-arms automatically if the
-- subscription renews to a new period_end).
ALTER TABLE subscriptions ADD COLUMN renewal_reminder_sent_for TEXT;
