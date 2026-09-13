-- Failed referral claims, so a typed code cannot be fished for.
--
-- The invite code stopped being something only a link could carry: a friend who
-- opened the link on their phone and signed up on a laptop had nothing in the
-- laptop's localStorage, so there is now a field to type it into. A field is a
-- thing people try codes in.
--
-- Guessing one is not the worry — a customer number and its suffix are six hex
-- characters each, 48 bits, and no amount of trying finds one. What a cap is
-- worth is the cost: each attempt is several D1 reads and sometimes a call to
-- Clerk, and an authenticated loop should not get those for free.
--
-- Only the attempts that look like fishing are written here: a token that does
-- not parse, or one that resolves to nobody. Being told "you are not new any
-- more" is a right answer about a real code, and locking somebody out for
-- reading it twice would be the rule punishing the wrong person.
--
-- Applied by hand, like every migration on rioko-db (see the runbook): never
-- `d1 migrations apply`.

CREATE TABLE IF NOT EXISTS referral_claim_attempts (
  user_id      TEXT NOT NULL,
  attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_referral_claim_attempts_user
  ON referral_claim_attempts(user_id, attempted_at);
