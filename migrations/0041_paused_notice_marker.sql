-- Marker for the "invoicing paused, N invoices waiting" campaign so a re-run
-- (or a second admin clicking the button) never mails the same merchant twice
-- in the same week. NULL = never notified.
ALTER TABLE subscriptions ADD COLUMN paused_notice_sent_at TEXT;
