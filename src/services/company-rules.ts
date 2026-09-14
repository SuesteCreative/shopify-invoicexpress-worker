import type { Env } from "../env";

/**
 * What the operator knows about a company that the code cannot infer.
 *
 * Diagnosing a failure for a client you administer daily is mostly recall: this
 * one's IX plan quota renews on the 5th, that one refuses simplified invoices,
 * this other one's Shopify sends VAT-included though the documents must be
 * excluded. The triage model had none of that and diagnosed every merchant as if
 * meeting them for the first time.
 *
 * Enforceable rules do NOT belong here — those are config columns the worker
 * reads, and a note that changes nothing while reading as though it does is
 * worse than no note. This is the residue: the context that explains failures
 * rather than causing them.
 */

/** Long enough for real context, short enough to stay a footnote to the incident. */
export const MAX_NOTES_CHARS = 1500;

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const NINE_DIGIT_RE = /\b\d{9}\b/g; // PT NIF shape

/**
 * Notes are operator-written, so they can contain anything the operator pasted —
 * including a customer's email or NIF from the ticket that prompted the note.
 * Scrubbed on the same rule as vendor error strings (see anthropic.scrubMessage),
 * because both end up in the same request.
 */
export function scrubNotes(notes: string): string {
  return String(notes)
    .replace(EMAIL_RE, "«email»")
    .replace(NINE_DIGIT_RE, "«nif»")
    .slice(0, MAX_NOTES_CHARS);
}

/**
 * The company's wall, newest first, trimmed to the budget above — or null.
 *
 * The operator's knowledge used to be one editable field (`company_rules.notes`)
 * and is now a feed of posts. Newest first because the budget cuts the TAIL, and
 * what was written most recently is the likeliest to still be true; a post that
 * falls off the end is the oldest one, not an arbitrary one.
 *
 * Best-effort by design: this decorates a diagnosis that is itself advisory, so
 * a missing table or a D1 blip must never be the reason an incident email fails
 * to go out. The old column is read as a fallback so a worker deployed before
 * migration 0064 still finds something.
 */
export async function getCompanyRulesNotes(env: Env, userId?: string | null): Promise<string | null> {
  if (!userId) return null;
  try {
    const rows = await env.DB.prepare(
      `SELECT body, created_at FROM account_posts
        WHERE user_id = ? AND deleted_at IS NULL
        ORDER BY created_at DESC, rowid DESC
        LIMIT 20`,
    ).bind(userId).all<{ body: string; created_at: string }>();

    const posts = (rows?.results ?? []).filter((p) => p?.body?.trim());
    if (posts.length > 0) {
      // Dated, because "portes a 0%" and the decision that reversed it read as a
      // contradiction without the two dates that order them.
      const joined = posts
        .map((p) => `[${String(p.created_at ?? "").slice(0, 10)}] ${p.body.trim()}`)
        .join("\n");
      return scrubNotes(joined);
    }
  } catch (e: any) {
    console.warn(`[company-rules] wall lookup failed (advisory, ignored): ${e?.message ?? e}`);
  }

  try {
    const row = await env.DB.prepare(
      "SELECT notes FROM company_rules WHERE user_id = ?",
    ).bind(userId).first<{ notes: string | null }>();

    const notes = row?.notes?.trim();
    return notes ? scrubNotes(notes) : null;
  } catch (e: any) {
    console.warn(`[company-rules] notes lookup failed (advisory, ignored): ${e?.message ?? e}`);
    return null;
  }
}
