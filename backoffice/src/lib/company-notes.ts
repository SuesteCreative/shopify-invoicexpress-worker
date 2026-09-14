// Relative, not "@/lib/…": this module is exercised by vitest from the repo
// root, where the backoffice's path alias is not configured. Its siblings in
// this directory import each other the same way.
import { auditConfigChange } from "./config-audit";

/**
 * What the operator knows about a company that the configuration cannot say.
 *
 * One note per account, written from two screens — the fiscal console at
 * /admin/client-rules and the Regras fiscais tab of the client record — and it
 * has to be the same note from both, or the operator keeps two and trusts
 * neither. This module is that single write path.
 *
 * Enforceable rules do NOT belong in here: a note changes no document. Its one
 * machine reader is the incident triage prompt (`getCompanyRulesNotes` in the
 * worker), which is handed the text with emails and tax numbers scrubbed out, so
 * an alert about this company is read with the context the operator has.
 */

/** Long enough for real context, short enough to stay a footnote to an incident.
 *  The worker caps at the same number when it feeds the triage prompt. */
export const MAX_NOTES_CHARS = 1500;

/**
 * Write the note, and say so in the audit trail.
 *
 * The audit is the part that did not exist. Migration 0035 declared a
 * `company_rules` scope and nothing ever wrote one — of the fiscal console's
 * four write shapes, the notes were the only one that left no record, so a note
 * could be replaced with no trace of who did it or what it said before.
 *
 * Returns `unchanged` rather than rewriting an identical note, so a blur event
 * on a field nobody typed in does not fill the trail with noise.
 */
export async function saveCompanyNotes(
  db: any,
  { accountId, actor, notes }: { accountId: string; actor: string; notes: string },
): Promise<{ unchanged: boolean }> {
  const next = String(notes ?? "").slice(0, MAX_NOTES_CHARS);

  const prior: any = await db.prepare("SELECT notes FROM company_rules WHERE user_id = ?")
    .bind(accountId).first().catch(() => null);
  if (String(prior?.notes ?? "") === next) return { unchanged: true };

  await db.prepare(
    `INSERT INTO company_rules (user_id, notes, updated_at, updated_by)
     VALUES (?, ?, CURRENT_TIMESTAMP, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       notes = excluded.notes,
       updated_at = CURRENT_TIMESTAMP,
       updated_by = excluded.updated_by`,
  ).bind(accountId, next, actor).run();

  // The note is already saved, so a failed audit is not a failed save — the same
  // order every other write on these two routes uses.
  await auditConfigChange(db, {
    userId: accountId,
    actor,
    scope: "company_rules",
    field: "notes",
    oldValue: prior?.notes ?? null,
    newValue: next || null,
  });

  return { unchanged: false };
}
