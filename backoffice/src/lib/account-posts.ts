import { auditConfigChange } from "./config-audit";

/**
 * The account wall: what the operator knows about a company, posted rather than
 * rewritten.
 *
 * This replaces the single editable note (`company_rules.notes`). That field was
 * replace-on-write, so two people editing the same company overwrote each other
 * silently, and it held only the current state — the decision and the decision
 * that reversed it could not both be there, so the reasoning was lost each time.
 *
 * Posts are append-only. Deletion sets a flag; the row stays, because this is
 * the same product that built `config_audit` after a blanked credential left no
 * trace of who blanked it.
 *
 * Enforceable behaviour does NOT go here. A post changes no document — what the
 * system applies is the connection's configuration and `account_rules`.
 */

/** Long enough for a real account of a decision, short enough to stay readable. */
export const MAX_POST_CHARS = 4000;

/** Newest first: the feed reads top-down and so does the triage prompt. */
export async function listAccountPosts(db: any, accountId: string, limit = 100) {
  const rows = await db.prepare(
    `SELECT p.id, p.body, p.created_at, p.author,
            u.name AS author_name, u.email AS author_email
       FROM account_posts p
       LEFT JOIN users u ON u.id = p.author
      WHERE p.user_id = ? AND p.deleted_at IS NULL
      -- rowid is SQLite's own insert counter, so two posts written inside the
      -- same second still order the way they were written. Tie-breaking on the
      -- id would be tie-breaking on a random UUID.
      ORDER BY p.created_at DESC, p.rowid DESC
      LIMIT ?`,
  ).bind(accountId, limit).all().catch(() => ({ results: [] }));
  return (rows.results ?? []) as any[];
}

/**
 * Post to a company's wall.
 *
 * The id is generated here rather than by the database so the caller can render
 * the new post without a second read.
 */
export async function createAccountPost(
  db: any,
  { accountId, author, body }: { accountId: string; author: string; body: string },
): Promise<{ id: string } | { error: string }> {
  const text = String(body ?? "").trim();
  if (!text) return { error: "empty" };

  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO account_posts (id, user_id, author, body) VALUES (?, ?, ?, ?)`,
  ).bind(id, accountId, author, text.slice(0, MAX_POST_CHARS)).run();

  // The wall is beside a company's fiscal configuration and is read as part of
  // its history, so who added to that history belongs in the same trail as who
  // changed the settings.
  await auditConfigChange(db, {
    userId: accountId,
    actor: author,
    scope: "account_posts",
    field: "post",
    oldValue: null,
    newValue: text.slice(0, MAX_POST_CHARS),
  });

  return { id };
}

/**
 * Hide a post. The row survives, with who hid it and when.
 *
 * Returns false when the post does not exist or belongs to another company —
 * the route answers 404 to both, so an id cannot be used to probe for one.
 */
export async function deleteAccountPost(
  db: any,
  { accountId, actor, postId }: { accountId: string; actor: string; postId: string },
): Promise<boolean> {
  const prior: any = await db.prepare(
    `SELECT body FROM account_posts WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
  ).bind(postId, accountId).first().catch(() => null);
  if (!prior) return false;

  await db.prepare(
    `UPDATE account_posts
        SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ?
      WHERE id = ? AND user_id = ?`,
  ).bind(actor, postId, accountId).run();

  await auditConfigChange(db, {
    userId: accountId,
    actor,
    scope: "account_posts",
    field: "post_deleted",
    oldValue: prior.body ?? null,
    newValue: null,
  });

  return true;
}
