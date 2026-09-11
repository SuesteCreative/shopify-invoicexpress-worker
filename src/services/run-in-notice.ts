import type { Env } from "../env";
import { sendEmail } from "./email";
import { resolveMerchantEmails } from "./incidents";
import { renderRunInCheckEmail } from "./email-templates";
import { connectionLabelOf } from "./connection-context";
import {
  RUN_IN_SOURCE, RUN_IN_DOCUMENTS, RUN_IN_REMINDER_DAYS, RUN_IN_ESCALATE_DAYS, RUN_IN_TOKEN_TTL_MS,
  countRunInDocuments, runInEnabled, wantsAutoFinalize,
} from "./run-in";

/**
 * The run-in's clock: counts what each new Stripe Connect connection has
 * issued, asks the merchant to check it, reminds once, and then stops emailing
 * them and tells us instead.
 *
 * Shaped on subscription-paused-notice.ts, including the part that matters
 * most: `dryRun` defaults to TRUE. Sending is opt-in, never the default, so a
 * bad deploy cannot mail the fleet.
 */

const OPS_EMAIL = "pedro@kapta.pt";

export interface RunInNoticeResult {
  checked: number;
  asked: number;
  reminded: number;
  escalated: number;
  skipped: number;
  dry_run: boolean;
  candidates: Array<{ user_id: string; destination: string; documents: number; action: string; would_email: string[] }>;
}

function daysSince(iso: string | null): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? (Date.now() - t) / 86_400_000 : 0;
}

function answerUrl(env: Env, token: string): string {
  const base = (env as any).WORKER_URL ?? "https://shopify-invoicexpress-worker.pedrotovarporto.workers.dev";
  return `${String(base).replace(/\/$/, "")}/runin/${token}`;
}

export async function runRunInNotices(env: Env, opts: { dryRun?: boolean; userId?: string } = {}): Promise<RunInNoticeResult> {
  const dryRun = opts.dryRun !== false;
  const out: RunInNoticeResult = { checked: 0, asked: 0, reminded: 0, escalated: 0, skipped: 0, dry_run: dryRun, candidates: [] };
  if (!runInEnabled(env)) return out;

  const rows: any[] = ((await env.DB.prepare(
    `SELECT id, user_id, destination_kind, destination_config_json, invoice_cutoff, created_at,
            runin_answer, runin_asked_at, runin_reminded_at, runin_token, runin_token_expires_at
       FROM connections
      WHERE source_kind = ? AND status = 'active' AND runin_answer IS NULL
        AND user_id IS NOT NULL AND user_id != ''`
  ).bind(RUN_IN_SOURCE).all()).results ?? []) as any[];

  for (const row of rows) {
    if (opts.userId && row.user_id !== opts.userId) continue;
    out.checked++;

    // A connection that never asked for automatic finalization is already
    // living the answer. Enrolling it would mean emailing a merchant about a
    // choice they made on purpose, and then offering to undo it.
    if (!wantsAutoFinalize(row.destination_config_json)) { out.skipped++; continue; }

    const since = row.invoice_cutoff ?? row.created_at ?? null;
    const documents = await countRunInDocuments(env, row.user_id, row.destination_kind, since);
    const label = connectionLabelOf(RUN_IN_SOURCE as any, row.destination_kind as any);
    const recipients = await resolveMerchantEmails(env, row.user_id);
    const record = (action: string) => out.candidates.push({
      user_id: row.user_id, destination: row.destination_kind, documents, action, would_email: recipients,
    });

    // 1. Not there yet.
    if (!row.runin_asked_at && documents < RUN_IN_DOCUMENTS) { out.skipped++; continue; }

    // 2. Ours now. The merchant has been asked and reminded and has answered
    //    nothing; a third email is nagging, not service. The connection keeps
    //    issuing drafts either way — nothing is stuck, nobody is at risk.
    if (row.runin_asked_at && daysSince(row.runin_asked_at) >= RUN_IN_ESCALATE_DAYS) {
      if (row.runin_reminded_at) {
        record("escalate");
        out.escalated++;
        if (!dryRun) {
          await sendEmail(env, {
            to: [OPS_EMAIL],
            subject: `Rodagem sem resposta: ${label} (${documents} rascunhos)`,
            html: `<p>A ligação <strong>${label}</strong> do utilizador <code>${row.user_id}</code> foi perguntada a `
              + `${String(row.runin_asked_at).slice(0, 10)}, lembrada a ${String(row.runin_reminded_at).slice(0, 10)}, `
              + `e continua sem resposta com ${documents} documentos em rascunho.</p>`
              + `<p>Link de resposta: ${answerUrl(env, row.runin_token)}</p>`,
          });
          // Re-stamped so the escalation is not repeated nightly for ever.
          await env.DB.prepare("UPDATE connections SET runin_reminded_at = ? WHERE id = ?")
            .bind(new Date().toISOString(), row.id).run();
        }
      } else { out.skipped++; }
      continue;
    }

    // 3. The reminder, once.
    if (row.runin_asked_at) {
      if (!row.runin_reminded_at && daysSince(row.runin_asked_at) >= RUN_IN_REMINDER_DAYS && recipients.length) {
        record("remind");
        out.reminded++;
        if (!dryRun) {
          const tpl = renderRunInCheckEmail({ answerUrl: answerUrl(env, row.runin_token), connectionLabel: label, documents, reminder: true });
          await sendEmail(env, { to: recipients, cc: [OPS_EMAIL], subject: tpl.subject, html: tpl.html });
          await env.DB.prepare("UPDATE connections SET runin_reminded_at = ? WHERE id = ?")
            .bind(new Date().toISOString(), row.id).run();
        }
      } else { out.skipped++; }
      continue;
    }

    // 4. The question. No recipients means a parked account — ask nobody.
    if (!recipients.length) { out.skipped++; continue; }
    record("ask");
    out.asked++;
    if (!dryRun) {
      const token = crypto.randomUUID();
      const now = new Date();
      await env.DB.prepare(
        "UPDATE connections SET runin_token = ?, runin_token_expires_at = ?, runin_asked_at = ?, updated_at = ? WHERE id = ?"
      ).bind(token, new Date(now.getTime() + RUN_IN_TOKEN_TTL_MS).toISOString(), now.toISOString(), now.toISOString(), row.id).run();

      const tpl = renderRunInCheckEmail({ answerUrl: answerUrl(env, token), connectionLabel: label, documents });
      await sendEmail(env, { to: recipients, cc: [OPS_EMAIL], subject: tpl.subject, html: tpl.html });
    }
  }

  return out;
}
