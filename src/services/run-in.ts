import type { Env } from "../env";

/**
 * The supervised run-in: a new Stripe Connect merchant's first documents stay
 * drafts until they have looked at them and said so.
 *
 * A certified document is communicated to the AT and can only be undone by a
 * credit note, so the first one a connection ever issues is the worst possible
 * moment to be certifying automatically — it is the one issued before anyone
 * has seen what this merchant's payments actually look like. The run-in turns
 * that into a question: five drafts, an email, an answer.
 *
 * Silence is never consent. The hold lifts on an explicit `yes` and on nothing
 * else — not on a timeout, not on a count.
 *
 * Only `stripe_connect`. The restricted-key Stripe connections, Shopify and
 * Lodgify carry a history of documents issued without any of this, and their
 * merchants have arranged around it.
 */

export const RUN_IN_SOURCE = "stripe_connect";

/** How many documents the merchant is asked to check. */
export const RUN_IN_DOCUMENTS = 5;

/** The question goes out once; one reminder a week later; then it is ours. */
export const RUN_IN_REMINDER_DAYS = 7;
export const RUN_IN_ESCALATE_DAYS = 14;

/** Long, because it is a link in an email a merchant may open next week. */
export const RUN_IN_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;

export interface RunInRow {
  id: string;
  user_id: string;
  destination_kind: string;
  runin_answer: string | null;
  runin_asked_at: string | null;
  runin_reminded_at: string | null;
  runin_token: string | null;
  runin_token_expires_at: string | null;
  invoice_cutoff: string | null;
  created_at: string | null;
  destination_config_json: string | null;
}

export function runInEnabled(env: Env): boolean {
  return (env as any).RUN_IN_ENABLED === "1";
}

/**
 * Does this connection want its documents certified without being asked?
 *
 * Read off the connection's own blob, as a JSON boolean, because that is what
 * `projectConnectionBehaviour` reads. A connection that is deliberately
 * draft-only — several merchants are — must never be enrolled and must never
 * be flipped to automatic by answering a question it was never sent.
 */
export function wantsAutoFinalize(destinationConfigJson: string | null): boolean {
  if (!destinationConfigJson) return false;
  try {
    return JSON.parse(destinationConfigJson)?.auto_finalize === true;
  } catch {
    return false;
  }
}

/**
 * The hold, as the pipeline asks it.
 *
 * One indexed read per document. It is not carried on the context because the
 * live path (`processStripeBatch`), the backfill and the re-emit each build
 * their config differently, and a gate that only some of them apply is the
 * asymmetry this exists to prevent.
 *
 * Fails CLOSED: if the row cannot be read, hold. An extra draft costs a click;
 * an unwanted certified document costs a credit note.
 */
export async function runInHoldsFinalize(
  env: Env,
  source: string,
  userId: string | null | undefined,
  destination: string | null | undefined,
): Promise<boolean> {
  if (!runInEnabled(env) || source !== RUN_IN_SOURCE || !userId) return false;
  try {
    const row: any = await env.DB.prepare(
      `SELECT runin_answer FROM connections
        WHERE user_id = ? AND source_kind = ? AND destination_kind = ? AND status = 'active'
        LIMIT 1`
    ).bind(userId, RUN_IN_SOURCE, destination ?? "invoicexpress").first();
    // No row at all means this is not a connection we govern (a backfill on a
    // paused row, say) — nothing to hold.
    if (!row) return false;
    return row.runin_answer !== "yes";
  } catch (e: any) {
    console.error(`[RunIn] Could not read the run-in state for ${userId}: ${e?.message ?? e} — holding the draft`);
    return true;
  }
}

/** The row the notice job and the answer handler both work from. */
export async function loadRunInRow(env: Env, token: string): Promise<RunInRow | null> {
  const row: any = await env.DB.prepare(
    `SELECT id, user_id, destination_kind, runin_answer, runin_asked_at, runin_reminded_at,
            runin_token, runin_token_expires_at, invoice_cutoff, created_at, destination_config_json
       FROM connections WHERE runin_token = ? LIMIT 1`
  ).bind(token).first();
  return (row as RunInRow) ?? null;
}

/**
 * Same shape as the OAuth state check: length first, then a constant-time
 * compare, then expiry — and a missing expiry counts as expired.
 */
export function tokenIsValid(row: RunInRow | null, received: string): boolean {
  if (!row?.runin_token || !row.runin_token_expires_at) return false;
  if (row.runin_token.length !== received.length) return false;
  let diff = 0;
  for (let i = 0; i < received.length; i++) diff |= row.runin_token.charCodeAt(i) ^ received.charCodeAt(i);
  if (diff !== 0) return false;
  return new Date(row.runin_token_expires_at).getTime() > Date.now();
}

/** Documents this connection has issued since Rioko took over its invoicing. */
export async function countRunInDocuments(
  env: Env,
  userId: string,
  destination: string,
  since: string | null,
): Promise<number> {
  const row: any = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM processed_orders
      WHERE user_id = ? AND source_kind = ? AND destination_kind = ? AND created_at >= ?`
  ).bind(userId, RUN_IN_SOURCE, destination, since ?? "1970-01-01").first();
  return Number(row?.n ?? 0);
}
