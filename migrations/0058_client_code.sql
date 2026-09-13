-- A customer number a human can say out loud.
--
-- Rioko keys every row it owns on `users.id`, the Clerk id of the person who
-- signed up: `user_3DtDCQn0mIe7T6Ynlx75wWOfUPn`. It is correct and it is
-- unusable by a person — it cannot be dictated on a support call, it does not
-- fit in an email subject, and nobody reads it back to confirm they are looking
-- at the same company. Everything else that identifies a client today is either
-- a LABEL (`admin_label`, `company_name` — explicitly non-fiscal), a string
-- owned by another platform (`shopify_domain`, `ix_account_name`,
-- `stripe_account_id`), a PAIR (`connection_key`), or a one-shot credential
-- (`onboarding_invites.token`). None of them is the account.
--
-- `RIO-1A2B3C`: six uppercase hex characters. The alphabet 0-9A-F carries no
-- visually confusable pair at all — there is no O against 0, no I or l against
-- 1 — and it is the same shape in both places that mint one: `hex(randomblob(3))`
-- here, `crypto.getRandomValues` in backoffice/src/lib/client-code.ts. No
-- translation layer between the backfill and the runtime means no drift between
-- them. 16.7M combinations, a unique index, and a retry where it is minted.
--
-- WHAT IT IS NOT. It is not a secret, and nothing may ever gate access on it:
-- that is why `onboarding_invites.token` carries a random suffix (0051) — that
-- one IS a credential. It is not fiscal either: it never reaches a document, a
-- series or a reference. It names the account, nothing else.
--
-- MEMBERS. An invited extra user (0039) also has a `users` row and also gets a
-- code. That is deliberate: neither insert site can know, at INSERT time, that
-- an invite is pending. A member's code resolves to a row that owns no data, so
-- the RESOLVER sends it to the owner's record; the minter stays branchless.
--
-- A CODE IS NEVER REPEATED AND NEVER REUSED. The unique index below is what
-- stops two live accounts sharing one. It is not what stops a code coming back:
-- `user.deleted` takes the `users` row, the code returns to the pool, and the
-- tables that deliberately survive a deletion (`processed_orders`,
-- `document_events`, `logs`) stay behind still describing that company. A code
-- reissued to somebody else would put two different companies' histories under
-- one number — the same defect as a duplicate, arriving later.
--
-- So `client_codes` is the ledger of every code ever issued, and the mint claims
-- it there FIRST. Deleting an account does not release its number, exactly as a
-- cancelled invoice does not release its number.
--
-- DELETED ACCOUNTS therefore: the account row goes, the code stays burnt, and a
-- Clerk user recreated afterwards gets a new id and a new code — right, because
-- the account it named is gone. Forensics keep working off `user_id`, which is
-- what those reads already use, and `client_codes.user_id` says which account a
-- retired number belonged to.
--
-- Apply by hand:
--   npx wrangler d1 execute rioko-db --remote --file migrations/0058_client_code.sql
-- NEVER `d1 migrations apply` on this database: its ledger is stuck at 0017 and
-- it would replay 0018+ onto columns that already exist.
ALTER TABLE users ADD COLUMN client_code TEXT;

-- Backfill BEFORE the index, on purpose. A collision then fails loudly as a
-- CREATE UNIQUE INDEX that will not build, instead of silently aborting an
-- UPDATE that looked like it ran. `randomblob()` is non-deterministic, so SQLite
-- evaluates it per row; `hex()` already returns uppercase, so three bytes are
-- exactly the six characters wanted and nothing needs upper() or substr().
--
-- If it does fail: find the duplicates, re-run this UPDATE scoped to them, and
-- create the index again. At 26 accounts over 16.7M codes that is roughly two
-- chances in a hundred thousand.
UPDATE users
   SET client_code = 'RIO-' || hex(randomblob(3))
 WHERE client_code IS NULL;

-- NULL is not a duplicate of NULL in SQLite, so a row that somehow arrives
-- without a code still inserts and is healed later by ensureClientCode().
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_client_code ON users(client_code);

-- The ledger. `code` is the primary key, so claiming one twice is impossible
-- whether or not the first holder still exists. `user_id` is who it was issued
-- to and is NOT a foreign key: the row has to outlive the account.
CREATE TABLE IF NOT EXISTS client_codes (
  code       TEXT PRIMARY KEY,
  user_id    TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_client_codes_user ON client_codes (user_id);

-- Every code the backfill just handed out, entered in the ledger.
INSERT OR IGNORE INTO client_codes (code, user_id)
SELECT client_code, id FROM users WHERE client_code IS NOT NULL;
