-- Extra users per account: one owner (free) + invited members (paid, one-off).
--
-- Rioko keys every row it owns on `users.id` (the Clerk id of the person who
-- signed up). A member never gets their own data: they act ON the owner's
-- account, so the whole platform resolves `account_id` instead of the raw auth
-- id (see backoffice/src/lib/account.ts).
--
-- `role`:   'admin'  → everything the owner can do (billing included)
--           'viewer' → read-only (writes blocked in middleware + helper)
-- `status`: 'pending' (invited, not signed up yet) | 'active' | 'revoked'
--
-- Seats are a POOL the account owns, not a fee per person. A seat is charged
-- ONCE, when an invite is sent with no free seat left (a €1.50 + IVA Stripe
-- invoice against the saved card) and `seat_invoice_id` records that purchase.
-- Removing someone frees their seat without a refund: the next invite reuses it
-- for nothing and points at the purchase it consumed through `seat_reused_from`.
-- Paid seats owned  = rows with a seat_invoice_id, revoked ones included.
-- Seats occupied    = rows in 'pending' or 'active'.
CREATE TABLE IF NOT EXISTS account_members (
    id                  TEXT PRIMARY KEY,
    account_id          TEXT NOT NULL,          -- users.id of the account owner
    email               TEXT NOT NULL,          -- invited address (lowercased)
    member_user_id      TEXT,                   -- Clerk id, NULL until they sign up
    role                TEXT NOT NULL DEFAULT 'viewer',
    status              TEXT NOT NULL DEFAULT 'pending',
    invited_by          TEXT,                   -- users.id that sent the invite
    clerk_invitation_id TEXT,
    seat_invoice_id     TEXT,                   -- Stripe invoice of the one-off seat
    seat_amount_cents   INTEGER,
    seat_paid_at        TEXT,
    seat_reused_from    TEXT,                   -- id of the paid row whose freed seat this took
    created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    accepted_at         TEXT,
    revoked_at          TEXT
);

-- One live seat per address per account; a revoked row stays for the audit
-- trail and must not block a re-invite, hence the partial index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_members_live
    ON account_members(account_id, email) WHERE status <> 'revoked';

-- The hot path: every request resolves "which account is this person in?".
CREATE INDEX IF NOT EXISTS idx_account_members_member
    ON account_members(member_user_id, status);

CREATE INDEX IF NOT EXISTS idx_account_members_account
    ON account_members(account_id, status);
