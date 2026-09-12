-- "Convide um amigo, ganhe 2 meses."
--
-- The states are the money, so each one is guarded by a constraint rather than
-- by a check in application code. The two things that must never happen — an
-- account referred twice, an account referring itself — are cheaper to make
-- impossible than to test for, and a UNIQUE index does not forget under a
-- concurrent webhook the way an `if` around a SELECT does.
--
-- Three rules, three constraints:
--   * PRIMARY KEY (invitee_user_id)      one account is referred once, for ever
--   * CHECK (inviter <> invitee)         nobody invites themselves
--   * UNIQUE (invitee_first_invoice_id)  one credit per invoice, whatever Stripe
--                                        re-delivers
--
-- The inviter's reward is a Stripe CUSTOMER BALANCE credit, not a coupon on the
-- subscription. An inviter may be monthly, annual, on a legacy price, or not yet
-- paying at all; a balance credit is the only instrument that behaves in all
-- four cases, stacks without limit across referrals (the copy promises no cap),
-- and lands on whatever invoice comes next. It is deliberately account-scoped:
-- the balance lives on the Stripe Customer and an account has one Customer with
-- several subscriptions (PK (user_id, connection_key) since 0044). Trying to bind
-- a credit to a connection would be inventing data — `billing_events` does not
-- even carry connection_key.
--
-- The invitee's free month is NOT in this table. It is `early_bird = 1` plus a
-- `trial_end` thirty days out on their own `subscriptions` row, which is what the
-- gate already reads — the feature existed, it just had nobody granting it.
--
-- Apply by hand:
--   npx wrangler d1 execute rioko-db --remote --file migrations/0057_referrals.sql
-- NEVER `d1 migrations apply` on this database: its ledger is stuck at 0017 and
-- it would replay 0018+ onto columns that already exist.

CREATE TABLE referral_codes (
  code       TEXT PRIMARY KEY,           -- slug-12hex, same shape as an onboarding invite
  user_id    TEXT NOT NULL UNIQUE,       -- one code per account, minted once and kept
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE referrals (
  invitee_user_id          TEXT PRIMARY KEY,
  code                     TEXT NOT NULL,
  inviter_user_id          TEXT NOT NULL,
  state                    TEXT NOT NULL DEFAULT 'pending', -- pending|paid|credited
  claimed_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  invitee_first_invoice_id TEXT,          -- set when the invitee first pays
  invitee_paid_at          TEXT,
  credit_cents             INTEGER,
  credit_txn_id            TEXT,          -- Stripe balance transaction
  credited_at              TEXT,
  note                     TEXT,          -- why a credit is still parked, when it is
  CHECK (inviter_user_id <> invitee_user_id)
);

CREATE INDEX        idx_referrals_inviter ON referrals(inviter_user_id, state);
CREATE UNIQUE INDEX idx_referrals_invoice ON referrals(invitee_first_invoice_id);
