-- Seats become a thing the account BUYS, separate from the person sitting in one.
--
-- 0039 charged the seat as a side effect of sending an invite, so a seat could
-- not exist before a member did. The Users page shows the account its seats: the
-- ones it owns (empty or occupied) and one locked slot underneath with the price
-- on it. Unlocking is the payment; inviting is free and only fills a seat the
-- account already owns.
--
-- Seats owned    = rows here (never deleted: removing a member frees the seat,
--                  it does not refund it)
-- Seats occupied = account_members rows in 'pending' or 'active'
-- Seats free     = owned - occupied
CREATE TABLE IF NOT EXISTS account_seats (
    id                TEXT PRIMARY KEY,
    account_id        TEXT NOT NULL,
    stripe_invoice_id TEXT,              -- NULL for a seat granted to an exempt account
    amount_cents      INTEGER,
    purchased_by      TEXT,              -- users.id that clicked unlock
    created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_account_seats_account ON account_seats(account_id);

-- Seats bought under 0039 (charged on the invite) become rows here, so the pool
-- has one source of truth. No-op on a database where nobody was invited yet.
INSERT INTO account_seats (id, account_id, stripe_invoice_id, amount_cents, purchased_by, created_at)
SELECT 'legacy-' || id, account_id, seat_invoice_id, seat_amount_cents, invited_by, created_at
FROM account_members
WHERE seat_invoice_id IS NOT NULL;
