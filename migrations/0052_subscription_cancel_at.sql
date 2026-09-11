-- When a subscription is due to stop, and whether the client was told.
--
-- The old prices (5 €/month, 50 €/year) end with the subscriptions that carry
-- them: an annual at the end of the period already paid for, a monthly on
-- 01/01/2027. Stripe holds that date, so nothing here has to wake up daily and
-- check: `cancel_at_period_end` for the annuals, `cancel_at` for the monthlies,
-- set once, and Stripe cancels on the day.
--
-- `cancel_at_period_end` already had a column. `cancel_at` did not, and without
-- it the fixed date lives only inside Stripe: the admin could not show it, and
-- the renewal reminder — which asks for `cancel_at_period_end = 1` — would never
-- see a monthly marked this way.
ALTER TABLE subscriptions ADD COLUMN cancel_at TEXT;

-- Which legacy notice this row has had, as `<data de fim>#<fase>`, the same
-- shape `early_bird_reminder_sent_for` uses. Per ROW, unlike the two markers
-- that came before it: those filter on `user_id` alone and stamp every
-- subscription an account has, so a second connection is never told anything.
ALTER TABLE subscriptions ADD COLUMN legacy_notice_sent_for TEXT;
