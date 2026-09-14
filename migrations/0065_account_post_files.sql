-- Files attached to a wall post.
--
-- NEVER run `wrangler d1 migrations apply` on this database. Its ledger stopped
-- at 0017. By hand:
--   npx wrangler d1 execute rioko-db --remote --file migrations/0065_account_post_files.sql
--
-- The bytes live in Vercel Blob (store `rioko-account-files`, region fra1,
-- access PRIVATE), not here and not in D1. D1 rows are metadata only: what the
-- file is called, what it is, how big, and where to find it.
--
-- Private, not public: a public blob is reachable by anyone holding its URL, and
-- these are a client's documents. Reads go through an authenticated route that
-- streams the bytes, so a file is only ever served to an operator who could
-- already open the client's record.
--
-- fra1 because the files belong to Portuguese clients. The store defaulted to
-- iad1 (US East) and was recreated in Frankfurt before anything was written to
-- it: a client's documents are not something to move across the Atlantic by
-- accepting a default.
--
-- `user_id` is denormalised off the post so that serving a file can scope the
-- lookup to the account in the URL without a join — the check that stops one
-- company's file being fetched from another company's record.
CREATE TABLE IF NOT EXISTS account_post_files (
  id           TEXT PRIMARY KEY,
  post_id      TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  pathname     TEXT NOT NULL,   -- the key inside the blob store
  filename     TEXT NOT NULL,   -- what the operator called it
  content_type TEXT NOT NULL,   -- what we VERIFIED it to be, not what was claimed
  size_bytes   INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at   TEXT,
  deleted_by   TEXT
);

CREATE INDEX IF NOT EXISTS idx_account_post_files_post
  ON account_post_files (post_id);

CREATE INDEX IF NOT EXISTS idx_account_post_files_user
  ON account_post_files (user_id, created_at);
