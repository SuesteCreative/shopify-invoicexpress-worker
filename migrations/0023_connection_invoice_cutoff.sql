-- Per-connection "don't invoice bookings created before this ISO date".
-- NULL = no cutoff (invoice everything) → preserves behaviour for all existing
-- connections. Set to the subscription start date when a paused connection is
-- activated by payment (see the Stripe webhook's activatePausedConnections).
-- Enforced by the Lodgify poll: bookings with created_at < invoice_cutoff are
-- mirrored for reconciliação but never invoiced (no retroactive billing of
-- pre-subscription history).
ALTER TABLE connections ADD COLUMN invoice_cutoff TEXT;
