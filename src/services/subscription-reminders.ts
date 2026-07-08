import type { Env } from "../env";
import { sendEmail } from "./email";

// Internal address always copied on renewal reminders so Kapta can follow up.
const OPS_EMAIL = "pedro@kapta.pt";

interface DueSub {
  user_id: string;
  email: string | null;
  name: string | null;
  plan: string | null;
  current_period_end: string;
}

export interface RenewalReminderResult {
  checked: number;
  sent: number;
  failed: number;
  dry_run: boolean;
  due: Array<{ user_id: string; email: string | null; period_end: string; would_email: string[] }>;
}

function ptDate(iso: string): string {
  const ymd = String(iso).slice(0, 10);
  const [y, m, d] = ymd.split("-");
  return d && m && y ? `${d}/${m}/${y}` : ymd;
}

function renewalEmail(name: string | null, plan: string | null, endPt: string): { subject: string; html: string } {
  const who = name && name.trim() ? name.trim() : "Olá";
  const planLabel = plan === "annual" ? "anual" : plan === "monthly" ? "mensal" : "";
  const subject = `A tua subscrição Rioko termina a ${endPt}`;
  const html = `<!-- renewal reminder -->
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#0f172a;">
  <div style="padding:28px 32px;border:1px solid #e2e8f0;border-radius:16px;">
    <p style="font-size:13px;letter-spacing:0.18em;text-transform:uppercase;color:#64748b;margin:0 0 18px;">Rioko</p>
    <h1 style="font-size:20px;font-weight:600;margin:0 0 16px;">${who},</h1>
    <p style="font-size:15px;line-height:1.6;margin:0 0 14px;">
      A tua subscrição Rioko${planLabel ? ` (${planLabel})` : ""} termina a <strong>${endPt}</strong>.
    </p>
    <p style="font-size:15px;line-height:1.6;margin:0 0 14px;">
      Para continuares a emitir as tuas faturas automaticamente sem interrupção,
      renova a subscrição antes dessa data.
    </p>
    <p style="font-size:15px;line-height:1.6;margin:0 0 22px;">
      Qualquer dúvida, responde a este email ou contacta <a href="mailto:${OPS_EMAIL}" style="color:#028dc4;">${OPS_EMAIL}</a>.
    </p>
    <p style="font-size:13px;color:#64748b;margin:0;">Obrigado,<br/>Equipa Rioko · Kapta</p>
  </div>
</div>`;
  return { subject, html };
}

function earlyBirdEndingEmail(name: string | null, endPt: string): { subject: string; html: string } {
  const who = name && name.trim() ? name.trim() : "Olá";
  const subject = `O teu acesso Early Bird Rioko termina a ${endPt}`;
  const html = `<!-- early-bird ending reminder -->
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#0f172a;">
  <div style="padding:28px 32px;border:1px solid #e2e8f0;border-radius:16px;">
    <p style="font-size:13px;letter-spacing:0.18em;text-transform:uppercase;color:#64748b;margin:0 0 18px;">Rioko</p>
    <h1 style="font-size:20px;font-weight:600;margin:0 0 16px;">${who},</h1>
    <p style="font-size:15px;line-height:1.6;margin:0 0 14px;">
      O teu período <strong>Early Bird</strong> (acesso gratuito) termina a <strong>${endPt}</strong>.
    </p>
    <p style="font-size:15px;line-height:1.6;margin:0 0 14px;">
      A partir dessa data, para continuares a emitir as tuas faturas automaticamente,
      precisas de ativar a subscrição. Podes fazê-lo já na tua página de faturação —
      os planos estão disponíveis aí.
    </p>
    <p style="font-size:15px;line-height:1.6;margin:0 0 22px;">
      Qualquer dúvida, responde a este email ou contacta <a href="mailto:${OPS_EMAIL}" style="color:#028dc4;">${OPS_EMAIL}</a>.
    </p>
    <p style="font-size:13px;color:#64748b;margin:0;">Obrigado,<br/>Equipa Rioko · Kapta</p>
  </div>
</div>`;
  return { subject, html };
}

/**
 * Daily early-bird ending sweep. Emails Shopify pilots ~1 day before their
 * free early-bird grace (trial_end, no Stripe sub yet) ends, prompting them to
 * subscribe so invoicing isn't interrupted. Per-client date (each sub's own
 * trial_end). Idempotent via subscriptions.early_bird_reminder_sent_for.
 */
export async function runEarlyBirdEndingReminders(
  env: Env,
  opts: { dryRun?: boolean; windowHours?: number } = {},
): Promise<RenewalReminderResult> {
  const dryRun = !!opts.dryRun;
  const windowHours = opts.windowHours ?? 36;
  const now = new Date();
  const until = new Date(now.getTime() + windowHours * 3600000);

  const rows = await env.DB.prepare(
    `SELECT user_id, email, name, plan, trial_end AS current_period_end
     FROM subscriptions
     WHERE status = 'trialing'
       AND early_bird = 1
       AND stripe_subscription_id IS NULL
       AND trial_end IS NOT NULL
       AND trial_end > ?
       AND trial_end <= ?
       AND (early_bird_reminder_sent_for IS NULL OR early_bird_reminder_sent_for <> trial_end)`
  ).bind(now.toISOString(), until.toISOString()).all();

  const subs = (rows.results ?? []) as unknown as DueSub[];
  const result: RenewalReminderResult = { checked: subs.length, sent: 0, failed: 0, dry_run: dryRun, due: [] };

  for (const s of subs) {
    const to = s.email ? [String(s.email)] : [];
    const recipients = to.length ? to : [OPS_EMAIL];
    const cc = to.length ? [OPS_EMAIL] : undefined;
    result.due.push({ user_id: s.user_id, email: s.email, period_end: s.current_period_end, would_email: [...recipients, ...(cc ?? [])] });
    if (dryRun) continue;

    const { subject, html } = earlyBirdEndingEmail(s.name, ptDate(s.current_period_end));
    const res = await sendEmail(env, { to: recipients, cc, subject, html });
    if (res.ok) {
      result.sent++;
      await env.DB.prepare(
        `UPDATE subscriptions SET early_bird_reminder_sent_for = ?, updated_at = ? WHERE user_id = ?`
      ).bind(s.current_period_end, new Date().toISOString(), s.user_id).run();
    } else {
      result.failed++;
      console.error(`[EarlyBirdReminder] send failed for ${s.user_id}: ${res.provider} ${res.detail ?? ""}`);
    }
  }

  return result;
}

/**
 * Daily renewal reminder sweep. Finds ending subscriptions
 * (cancel_at_period_end=1) whose period_end is within the next `windowDays`
 * (default 7) and that haven't been reminded for this period yet, then emails
 * the customer (cc ops) — or ops only when no customer email is on file.
 * Idempotent via subscriptions.renewal_reminder_sent_for (set only on success).
 */
export async function runRenewalReminders(
  env: Env,
  opts: { dryRun?: boolean; windowDays?: number } = {},
): Promise<RenewalReminderResult> {
  const dryRun = !!opts.dryRun;
  const windowDays = opts.windowDays ?? 7;
  const now = new Date();
  const until = new Date(now.getTime() + windowDays * 86400000);

  const rows = await env.DB.prepare(
    `SELECT user_id, email, name, plan, current_period_end
     FROM subscriptions
     WHERE status IN ('active','trialing')
       AND cancel_at_period_end = 1
       AND current_period_end IS NOT NULL
       AND current_period_end > ?
       AND current_period_end <= ?
       AND (renewal_reminder_sent_for IS NULL OR renewal_reminder_sent_for <> current_period_end)`
  ).bind(now.toISOString(), until.toISOString()).all();

  const subs = (rows.results ?? []) as unknown as DueSub[];
  const result: RenewalReminderResult = { checked: subs.length, sent: 0, failed: 0, dry_run: dryRun, due: [] };

  for (const s of subs) {
    const to = s.email ? [String(s.email)] : [];
    const recipients = to.length ? to : [OPS_EMAIL];
    const cc = to.length ? [OPS_EMAIL] : undefined;
    result.due.push({ user_id: s.user_id, email: s.email, period_end: s.current_period_end, would_email: [...recipients, ...(cc ?? [])] });
    if (dryRun) continue;

    const { subject, html } = renewalEmail(s.name, s.plan, ptDate(s.current_period_end));
    const res = await sendEmail(env, { to: recipients, cc, subject, html });
    if (res.ok) {
      result.sent++;
      await env.DB.prepare(
        `UPDATE subscriptions SET renewal_reminder_sent_for = ?, updated_at = ? WHERE user_id = ?`
      ).bind(s.current_period_end, new Date().toISOString(), s.user_id).run();
    } else {
      result.failed++;
      console.error(`[RenewalReminder] send failed for ${s.user_id}: ${res.provider} ${res.detail ?? ""}`);
    }
  }

  return result;
}
