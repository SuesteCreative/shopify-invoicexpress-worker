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

/** Where the monthly/annual plan cards live on the marketing site. */
const PRICING_URL = "https://rioko.online/pt#preco";

/**
 * The three touches of the early-bird wind-down sequence, most distant first.
 * `days` is the "days remaining" threshold that opens the touch — with a
 * 2026-09-01 trial_end that puts the first email on 15 August, as briefed.
 * Order matters: the runner only ever advances to a more urgent stage.
 */
export const EARLY_BIRD_STAGES = [
  { key: "d17", days: 17 },
  { key: "d7", days: 7 },
  { key: "d1", days: 1 },
] as const;
type StageKey = (typeof EARLY_BIRD_STAGES)[number]["key"];

const STAGE_COPY: Record<StageKey, { eyebrow: string; subject: (d: string) => string; lead: (d: string) => string }> = {
  d17: {
    eyebrow: "Early Bird",
    subject: (d) => `O teu acesso Early Bird termina a ${d}`,
    lead: (d) => `O teu acesso <strong>Early Bird</strong> — faturação automática sem custos — termina a <strong>${d}</strong>.`,
  },
  d7: {
    eyebrow: "Faltam 7 dias",
    subject: (d) => `Faltam 7 dias — o teu Early Bird termina a ${d}`,
    lead: (d) => `Falta pouco: o teu acesso <strong>Early Bird</strong> termina a <strong>${d}</strong>.`,
  },
  d1: {
    eyebrow: "Último dia",
    subject: (d) => `Amanhã termina o teu acesso Early Bird`,
    lead: (d) => `Amanhã, <strong>${d}</strong>, termina o teu acesso <strong>Early Bird</strong>.`,
  },
};

function earlyBirdEndingEmail(name: string | null, endPt: string, stage: StageKey): { subject: string; html: string } {
  const who = name && name.trim() ? name.trim().split(/\s+/)[0] : "Olá";
  const copy = STAGE_COPY[stage];
  const subject = copy.subject(endPt);

  // Table-based, fully inline: Gmail/Outlook strip <style> blocks and flexbox.
  const html = `<!-- early-bird wind-down · stage ${stage} -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Ativa um plano para manteres a faturação automática a partir de ${endPt}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f8fa;margin:0;padding:32px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid #e3e8ee;border-radius:18px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

      <tr><td style="height:4px;background:#028dc4;font-size:0;line-height:0;">&nbsp;</td></tr>

      <tr><td style="padding:32px 36px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="font-size:15px;font-weight:700;letter-spacing:-0.01em;color:#0b1524;padding-right:10px;">Rioko</td>
          <td style="font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#028dc4;background:#e8f6fc;border-radius:999px;padding:4px 10px;">${copy.eyebrow}</td>
        </tr></table>
      </td></tr>

      <tr><td style="padding:22px 36px 0;">
        <h1 style="margin:0 0 14px;font-size:22px;line-height:1.3;font-weight:650;letter-spacing:-0.02em;color:#0b1524;">${who},</h1>
        <p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#3c4a5c;">${copy.lead(endPt)}</p>
        <p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#3c4a5c;">
          Para continuar tudo como está — cada encomenda paga a gerar a fatura sozinha,
          sem tocares em nada — basta escolheres um plano antes dessa data.
        </p>
      </td></tr>

      <tr><td style="padding:10px 36px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="background:#028dc4;border-radius:10px;">
            <a href="${PRICING_URL}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;letter-spacing:-0.01em;">Ver planos &nbsp;&rarr;</a>
          </td>
        </tr></table>
        <p style="margin:12px 0 0;font-size:13px;line-height:1.6;color:#7a8899;">Mensal ou anual. Escolhes na página, ativas em menos de um minuto.</p>
      </td></tr>

      <tr><td style="padding:24px 36px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fafbfc;border:1px solid #eceff3;border-radius:12px;">
          <tr><td style="padding:14px 16px;font-size:13.5px;line-height:1.6;color:#5b6879;">
            A partir de ${endPt}, sem plano ativo as encomendas continuam a entrar normalmente
            na tua loja — apenas deixam de ser faturadas automaticamente até ativares a subscrição.
          </td></tr>
        </table>
      </td></tr>

      <tr><td style="padding:24px 36px 32px;">
        <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#5b6879;">
          Dúvidas sobre qual plano faz sentido? Responde a este email ou escreve para
          <a href="mailto:${OPS_EMAIL}" style="color:#028dc4;text-decoration:none;font-weight:500;">${OPS_EMAIL}</a>.
        </p>
        <div style="border-top:1px solid #eceff3;padding-top:16px;">
          <p style="margin:0;font-size:13px;line-height:1.6;color:#8a97a6;">Equipa Rioko · Kapta<br/><a href="https://rioko.online" style="color:#8a97a6;text-decoration:none;">rioko.online</a></p>
        </div>
      </td></tr>

    </table>
  </td></tr>
</table>`;
  return { subject, html };
}

/**
 * Daily early-bird wind-down sweep — a three-touch sequence (17 / 7 / 1 days
 * before each subscription's own trial_end) prompting the merchant to pick a
 * plan before automatic invoicing pauses.
 *
 * Two things this deliberately does differently from the old version:
 *
 *  • Recipients come from `users`, not `subscriptions`. Every early-bird row has
 *    subscriptions.email = NULL, so the previous query silently addressed the
 *    whole campaign to ops and no merchant ever heard from us.
 *  • Internal accounts (superadmin/hiperadmin) are excluded — the gate exempts
 *    them anyway, so a "your access is ending" email would be false.
 *
 * Idempotency: `early_bird_reminder_sent_for` stores `<trial_end>#<stage>`. A
 * stage is only sent when it is strictly more urgent than the stored one, so
 * moving trial_end restarts the sequence and a re-run never double-sends. A
 * legacy bare `<trial_end>` value is treated as "sequence already finished".
 */
export async function runEarlyBirdEndingReminders(
  env: Env,
  opts: { dryRun?: boolean; now?: Date } = {},
): Promise<RenewalReminderResult> {
  const dryRun = !!opts.dryRun;
  const now = opts.now ?? new Date();

  const rows = await env.DB.prepare(
    `SELECT s.user_id,
            COALESCE(NULLIF(TRIM(s.email), ''), u.email)                          AS email,
            COALESCE(NULLIF(TRIM(s.name), ''), u.admin_label, u.name, u.company_name) AS name,
            s.plan,
            s.trial_end                                                            AS current_period_end,
            s.early_bird_reminder_sent_for                                         AS marker
       FROM subscriptions s
       LEFT JOIN users u ON u.id = s.user_id
      WHERE s.status = 'trialing'
        AND s.early_bird = 1
        AND s.stripe_subscription_id IS NULL
        AND s.trial_end IS NOT NULL
        AND s.trial_end > ?
        AND COALESCE(u.role, 'user') NOT IN ('superadmin', 'hiperadmin')`
  ).bind(now.toISOString()).all();

  const subs = (rows.results ?? []) as unknown as Array<DueSub & { marker: string | null }>;
  const result: RenewalReminderResult = { checked: 0, sent: 0, failed: 0, dry_run: dryRun, due: [] };

  for (const s of subs) {
    const endsAt = new Date(s.current_period_end);
    if (Number.isNaN(endsAt.getTime())) continue;
    const daysLeft = (endsAt.getTime() - now.getTime()) / 86_400_000;

    // Legacy marker (no stage suffix) for this same trial_end = already done.
    const marker = s.marker ?? "";
    if (marker === s.current_period_end) continue;
    const sentStage = marker.startsWith(`${s.current_period_end}#`) ? marker.split("#")[1] : null;
    const sentIdx = sentStage ? EARLY_BIRD_STAGES.findIndex((st) => st.key === sentStage) : -1;

    // Most urgent stage that is due; only advance past what was already sent.
    let dueIdx = -1;
    for (let i = 0; i < EARLY_BIRD_STAGES.length; i++) {
      if (daysLeft <= EARLY_BIRD_STAGES[i].days) dueIdx = i;
    }
    if (dueIdx < 0 || dueIdx <= sentIdx) continue;

    const stage = EARLY_BIRD_STAGES[dueIdx].key;
    result.checked++;

    const to = s.email ? [String(s.email)] : [];
    const recipients = to.length ? to : [OPS_EMAIL];
    const cc = to.length ? [OPS_EMAIL] : undefined;
    result.due.push({ user_id: s.user_id, email: s.email, period_end: s.current_period_end, would_email: [...recipients, ...(cc ?? [])] });
    if (dryRun) continue;

    const { subject, html } = earlyBirdEndingEmail(s.name, ptDate(s.current_period_end), stage);
    const res = await sendEmail(env, { to: recipients, cc, subject, html });
    if (res.ok) {
      result.sent++;
      await env.DB.prepare(
        `UPDATE subscriptions SET early_bird_reminder_sent_for = ?, updated_at = ? WHERE user_id = ?`
      ).bind(`${s.current_period_end}#${stage}`, new Date().toISOString(), s.user_id).run();
    } else {
      result.failed++;
      console.error(`[EarlyBirdReminder] send failed for ${s.user_id} (${stage}): ${res.provider} ${res.detail ?? ""}`);
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
