import { put, del, get } from "@vercel/blob";
import { auditConfigChange } from "./config-audit";
import { identifyFile, safeFilename, MAX_FILE_BYTES, MAX_FILES_PER_POST } from "./account-file-types";

/**
 * Files attached to a wall post.
 *
 * The bytes live in Vercel Blob (`rioko-account-files`, fra1, access PRIVATE);
 * D1 holds only what the file is called, what we VERIFIED it to be, how big it
 * is and where to find it.
 *
 * Private rather than public, because a public blob is readable by anyone who
 * has its URL and these are a client's documents. Every read goes through a
 * route that has already decided the caller may open this client's record.
 */

const token = (env: any): string | undefined => env?.BLOB_READ_WRITE_TOKEN || undefined;

/**
 * Attachments for a set of posts, keyed by post.
 *
 * Wrapped whole, not just the promise: migrations here are applied by hand
 * AFTER the deploy, so between the two the table does not exist — and a driver
 * that throws while PREPARING the statement throws before there is a promise to
 * catch on. A wall that 500s because its attachments table is a few minutes
 * behind would be a worse bug than the one this feature fixes.
 */
export async function listPostFiles(db: any, postIds: string[]) {
  const byPost = new Map<string, any[]>();
  if (postIds.length === 0) return byPost;

  try {
    const marks = postIds.map(() => "?").join(",");
    const rows = await db.prepare(
      `SELECT id, post_id, filename, content_type, size_bytes
         FROM account_post_files
        WHERE post_id IN (${marks}) AND deleted_at IS NULL
        ORDER BY rowid ASC`,
    ).bind(...postIds).all();

    for (const row of (rows?.results ?? []) as any[]) {
      const list = byPost.get(row.post_id) ?? [];
      list.push(row);
      byPost.set(row.post_id, list);
    }
  } catch {
    // No table yet, or an unreadable one: posts without their attachments beat
    // no posts at all.
  }
  return byPost;
}

/**
 * Store one file against a post.
 *
 * The claimed content type is never trusted and never stored: `identifyFile`
 * reads the leading bytes and the answer is what gets written, so a PDF renamed
 * `.png` cannot later be served as an image.
 */
export async function attachFileToPost(
  db: any,
  env: any,
  { accountId, postId, actor, file }: { accountId: string; postId: string; actor: string; file: File },
): Promise<{ id: string } | { error: string }> {
  const rw = token(env);
  if (!rw) return { error: "blob_not_configured" };

  if (file.size > MAX_FILE_BYTES) return { error: "too_large" };
  if (file.size === 0) return { error: "empty" };

  const existing: any = await db.prepare(
    `SELECT COUNT(*) AS n FROM account_post_files WHERE post_id = ? AND deleted_at IS NULL`,
  ).bind(postId).first().catch(() => ({ n: 0 }));
  if (Number(existing?.n ?? 0) >= MAX_FILES_PER_POST) return { error: "too_many" };

  // The post has to belong to the account in the URL, or a file could be hung
  // off another company's wall by id.
  const post: any = await db.prepare(
    `SELECT id FROM account_posts WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
  ).bind(postId, accountId).first().catch(() => null);
  if (!post) return { error: "not_found" };

  const head = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
  const filename = safeFilename(file.name);
  const kind = identifyFile(filename, head);
  if (!kind) return { error: "unsupported_type" };

  const id = crypto.randomUUID();
  // Keyed by account and id, not by filename: two files called "fatura.pdf" on
  // the same wall must not collide, and the path must not be guessable from the
  // client's name.
  const pathname = `accounts/${accountId}/${id}.${kind.ext}`;

  await put(pathname, file, {
    access: "private",
    token: rw,
    contentType: kind.contentType,
    addRandomSuffix: false,
  });

  await db.prepare(
    `INSERT INTO account_post_files (id, post_id, user_id, pathname, filename, content_type, size_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, postId, accountId, pathname, filename, kind.contentType, file.size).run();

  await auditConfigChange(db, {
    userId: accountId,
    actor,
    scope: "account_posts",
    field: "file_attached",
    oldValue: null,
    newValue: `${filename} (${kind.contentType}, ${file.size} bytes)`,
  });

  return { id };
}

/** The bytes, or null. Scoped to the account so an id alone opens nothing. */
export async function readPostFile(db: any, env: any, { accountId, fileId }: { accountId: string; fileId: string }) {
  const rw = token(env);
  if (!rw) return null;

  const row: any = await db.prepare(
    `SELECT pathname, filename, content_type FROM account_post_files
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
  ).bind(fileId, accountId).first().catch(() => null);
  if (!row) return null;

  const result: any = await get(row.pathname, { access: "private", token: rw }).catch(() => null);
  if (!result || result.statusCode !== 200) return null;

  return { stream: result.stream as ReadableStream, filename: row.filename as string, contentType: row.content_type as string };
}

/**
 * Remove a file: the row is marked and the BYTES ARE DELETED.
 *
 * Deliberately unlike a post, whose text is kept. A post is a sentence somebody
 * wrote; a file is a client's document, and keeping copies of those after they
 * were asked to be removed is a liability rather than an audit trail. What
 * survives is the record that a file by that name existed and who removed it.
 */
export async function deletePostFile(
  db: any,
  env: any,
  { accountId, actor, fileId }: { accountId: string; actor: string; fileId: string },
): Promise<boolean> {
  const row: any = await db.prepare(
    `SELECT pathname, filename FROM account_post_files
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
  ).bind(fileId, accountId).first().catch(() => null);
  if (!row) return false;

  const rw = token(env);
  // The row is marked first: a blob that outlives its row is orphaned storage,
  // while a row that outlives its blob serves a 404 — the cheaper of the two.
  await db.prepare(
    `UPDATE account_post_files SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE id = ?`,
  ).bind(actor, fileId).run();

  if (rw) await del(row.pathname, { token: rw }).catch(() => undefined);

  await auditConfigChange(db, {
    userId: accountId,
    actor,
    scope: "account_posts",
    field: "file_deleted",
    oldValue: row.filename ?? null,
    newValue: null,
  });

  return true;
}

/** Every file of a post, removed with it. */
export async function deleteFilesOfPost(
  db: any, env: any, { accountId, actor, postId }: { accountId: string; actor: string; postId: string },
) {
  const rows = await db.prepare(
    `SELECT id FROM account_post_files WHERE post_id = ? AND user_id = ? AND deleted_at IS NULL`,
  ).bind(postId, accountId).all().catch(() => ({ results: [] }));

  for (const row of (rows.results ?? []) as any[]) {
    await deletePostFile(db, env, { accountId, actor, fileId: row.id });
  }
}
