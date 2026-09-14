-- The account wall: what the operator knows about a company, posted rather than
-- rewritten.
--
-- NEVER run `wrangler d1 migrations apply` on this database. Its ledger stopped
-- at 0017 and applying would replay everything since. This file goes on by hand:
--   npx wrangler d1 execute rioko-db --remote --file migrations/0064_account_posts.sql
--
-- WHY POSTS AND NOT THE BOX
--
-- `company_rules.notes` (0035) is one editable field per company. Two problems,
-- both real within a day of it being reachable from the client record:
--
--   1. It is replace-on-write. Two people — or two agents — editing the same
--      company silently overwrite each other, and the loser never finds out.
--   2. It holds the current state and loses the evolution. "Portes a 0% por
--      decisão de 12/08" and the decision that reversed it in October cannot
--      both be true, so one of them gets deleted and the reasoning goes with it.
--
-- Posts are append-only, so neither happens: concurrent writers both land, and
-- what was believed in August is still readable in October next to what replaced
-- it. Deletion is a flag, not a DELETE — this is the same product that built
-- `config_audit` because a blanked credential had left no trace of who blanked it.
CREATE TABLE IF NOT EXISTS account_posts (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  author     TEXT,            -- the operator who posted it
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,            -- soft: the feed hides it, the row stays
  deleted_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_account_posts_user
  ON account_posts (user_id, created_at);

-- The notes that already exist become the first post of their company's wall,
-- keeping the day they were written and whoever wrote them. Without this the
-- migration would quietly delete the only note the fleet had.
--
-- Guarded by NOT EXISTS so re-running the file cannot post them twice: this
-- database is migrated by hand, and a file that is not safe to run again is a
-- file that will eventually be run again.
INSERT INTO account_posts (id, user_id, author, body, created_at)
SELECT lower(hex(randomblob(16))),
       cr.user_id,
       cr.updated_by,
       cr.notes,
       COALESCE(cr.updated_at, CURRENT_TIMESTAMP)
  FROM company_rules cr
 WHERE cr.notes IS NOT NULL
   AND TRIM(cr.notes) != ''
   AND NOT EXISTS (SELECT 1 FROM account_posts p WHERE p.user_id = cr.user_id);
