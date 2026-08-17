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
 * The company's notes, or null. Best-effort by design: this decorates a
 * diagnosis that is itself advisory, so a missing table or a D1 blip must never
 * be the reason an incident email fails to go out.
 */
export async function getCompanyRulesNotes(env: Env, userId?: string | null): Promise<string | null> {
  if (!userId) return null;
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
