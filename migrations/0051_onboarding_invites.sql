-- A link handed to one client, with their subscription already settled.
--
-- A merchant who already pays — an annual on another connection, or the legacy
-- Shopify→IX pair they are moving away from — reached step six of a guided
-- onboarding and was shown a payment form. Since migration 0044 a subscription
-- pays for ONE connection, and the worker enforces it, so the new pair really is
-- uncovered; telling the client to ignore the step is how somebody pays twice.
--
-- An invite says, before the account even exists: when this person signs up, the
-- subscription named here starts paying for this pair instead.
--
-- The token is `<slug-da-empresa>-<sufixo aleatório>`: the name so support can
-- read it out loud, the suffix so it cannot be guessed. The company name alone
-- must never be the whole token — a link that grants free service to whoever
-- spells "cakeartmagazine" is not a link, it is a hole.
--
-- `from_connection_key` records which connection the subscription was paying for
-- until now. The move rewrites `metadata.connection_key` on the Stripe side, so
-- that old row will never receive another event: it is closed at claim time, or
-- it would sit `active` for ever and keep its gate open after a cancellation.
CREATE TABLE onboarding_invites (
  token TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  destination_kind TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL,
  from_connection_key TEXT,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  claimed_by_user_id TEXT,
  claimed_at TEXT
);

-- The admin list reads newest first, and support looks an account up by the
-- invite it was sent.
CREATE INDEX idx_onboarding_invites_created ON onboarding_invites(created_at DESC);
CREATE INDEX idx_onboarding_invites_claimed ON onboarding_invites(claimed_by_user_id);
