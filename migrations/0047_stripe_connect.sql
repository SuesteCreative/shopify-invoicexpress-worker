-- Stripe Connect → Moloni: a second, OAuth-based connection kind that lives
-- ALONGSIDE the existing `stripe` source. Nothing here changes an existing row:
-- every column is additive and NULL for the connections already in production.
--
-- oauth_state / oauth_state_expires_at hold the one-shot CSRF nonce while the
-- merchant is away on Stripe's (or Moloni's) consent screen. It has to survive
-- the round trip, and the Worker/Pages pair has no session store, so it lives on
-- the row it belongs to and is cleared the moment the code is exchanged.
--
-- last_token_refresh_at is the Moloni OAuth heartbeat. Moloni's refresh token
-- dies after 14 days of disuse and rotates on every use, so the nightly cron
-- needs to know when this connection was last renewed to decide whether to
-- renew it again.
ALTER TABLE connections ADD COLUMN oauth_state TEXT;
ALTER TABLE connections ADD COLUMN oauth_state_expires_at TEXT;
ALTER TABLE connections ADD COLUMN last_token_refresh_at TEXT;
