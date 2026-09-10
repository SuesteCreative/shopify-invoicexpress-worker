import type { Env } from "../env";
import { AppStorage } from "../storage";
import { sendEmail } from "./email";
import { loadInactiveUserIds } from "./inactive-accounts";
import { legalLinks } from "./email-templates";

// Internal address copied on every send so Kapta sees exactly what the
// merchant saw, in the same thread they may reply to.
const OPS_EMAIL = "pedro@kapta.pt";

/** The billing page — the subscribe cards live here. */
const BILLING_URL = "https://rioko.online/pt/faturacao";

export interface PausedNoticeCandidate {
  user_id: string;
  email: string | null;
  name: string | null;
  status: string | null;
  pending: number;
  since: string | null;
  would_email: string[];
  marker_stored: boolean;
}

export interface PausedNoticeResult {
  checked: number;
  sent: number;
  failed: number;
  skipped_no_pending: number;
  skipped_recent_notice: number;
  skipped_paused_shops: number;
  dry_run: boolean;
  candidates: PausedNoticeCandidate[];
}

function ptDate(iso: string): string {
  const ymd = String(iso).slice(0, 10);
  const [y, m, d] = ymd.split("-");
  return d && m && y ? `${d}/${m}/${y}` : ymd;
}

/**
 * "Invoicing is paused, N orders are waiting" — the email a merchant gets when
 * the gate has been turning their paid orders away. Table-based and fully
 * inline: Gmail and Outlook strip <style> blocks and flexbox.
 */
export function pausedNoticeEmail(
  name: string | null,
  pending: number,
  sincePt: string | null,
): { subject: string; html: string } {
  const who = name && name.trim() ? name.trim().split(/\s+/)[0] : "Olá";
  const n = pending;
  const invoiceWord = n === 1 ? "fatura" : "faturas";
  const waitingLine = n === 1 ? "encomenda paga à espera de fatura" : "encomendas pagas à espera de fatura";
  const subject = `A tua faturação está parada: ${n} ${invoiceWord} por emitir`;
  const sinceLine = sincePt ? ` desde <strong>${sincePt}</strong>` : "";

  const html = `<!-- subscription paused · ${n} pending -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${n} ${waitingLine}. Ativa um plano para retomar a emissão automática.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f8fa;margin:0;padding:32px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid #e3e8ee;border-radius:18px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

      <tr><td style="height:4px;background:#e11d48;font-size:0;line-height:0;">&nbsp;</td></tr>

      <tr><td style="padding:32px 36px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="font-size:15px;font-weight:700;letter-spacing:-0.01em;color:#0b1524;padding-right:10px;">Rioko</td>
          <td style="font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#e11d48;background:#fdeaee;border-radius:999px;padding:4px 10px;">Faturação parada</td>
        </tr></table>
      </td></tr>

      <tr><td style="padding:22px 36px 0;">
        <h1 style="margin:0 0 14px;font-size:22px;line-height:1.3;font-weight:650;letter-spacing:-0.02em;color:#0b1524;">${who},</h1>
        <p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#3c4a5c;">
          A tua subscrição Rioko não está ativa, por isso <strong>a emissão automática de faturas parou</strong>.
        </p>
        <p style="margin:0 0 18px;font-size:15px;line-height:1.65;color:#3c4a5c;">
          As vendas continuam a entrar normalmente na tua loja. O que ficou por fazer foi a fatura.
        </p>
      </td></tr>

      <tr><td style="padding:0 36px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fff8f9;border:1px solid #f7d3da;border-radius:12px;">
          <tr><td style="padding:18px 20px;">
            <p style="margin:0 0 4px;font-size:30px;line-height:1.1;font-weight:700;letter-spacing:-0.02em;color:#e11d48;">${n}</p>
            <p style="margin:0;font-size:14px;line-height:1.6;color:#7a3b47;">${waitingLine}${sinceLine}.</p>
          </td></tr>
        </table>
      </td></tr>

      <tr><td style="padding:22px 36px 0;">
        <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3c4a5c;">
          Ativa um plano e retomamos de imediato: as encomendas que ficaram para trás
          são faturadas e volta tudo ao automático, sem tocares em nada.
        </p>
      </td></tr>

      <tr><td style="padding:0 36px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="background:#028dc4;border-radius:10px;">
            <a href="${BILLING_URL}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;letter-spacing:-0.01em;">Ativar subscrição &nbsp;&rarr;</a>
          </td>
        </tr></table>
        <p style="margin:12px 0 0;font-size:13px;line-height:1.6;color:#7a8899;">
          7,50&euro;/mês ou 75&euro;/ano (+ IVA). Os cartões de pagamento estão nessa página, em Faturação.
        </p>
      </td></tr>

      <tr><td style="padding:24px 36px 32px;">
        <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#5b6879;">
          Se achas que isto é engano, ou queres ajuda a escolher o plano, responde a este email ou escreve para
          <a href="mailto:${OPS_EMAIL}" style="color:#028dc4;text-decoration:none;font-weight:500;">${OPS_EMAIL}</a>.
        </p>
        <div style="border-top:1px solid #eceff3;padding-top:16px;">
          <p style="margin:0;font-size:13px;line-height:1.6;color:#8a97a6;">Equipa Rioko · Kapta<br/><a href="https://rioko.online" style="color:#8a97a6;text-decoration:none;">rioko.online</a></p>${legalLinks("#8a97a6")}
        </div>
      </td></tr>

    </table>
  </td></tr>
</table>`;
  return { subject, html };
}

interface BlockedRow {
  user_id: string;
  email: string | null;
  name: string | null;
  status: string | null;
  marker: string | null;
  has_sub_row: number;
  int_total: number;
  int_active: number;
}

/**
 * Emails every merchant whose invoicing the subscription gate is currently
 * turning away, telling them how many orders are waiting and where to pay.
 *
 * Three deliberate guards, all learned from the digest's over-reporting:
 *
 *  • The count is VERIFIED. Order ids come from the `subscription_inactive`
 *    incidents, then anything already invoiced by any route is subtracted, so
 *    a merchant is never told about an order we did emit.
 *  • A merchant with zero verified pending orders is not emailed at all —
 *    "0 faturas pendentes" is a nag, not a notice.
 *  • Shops that are ALL paused are skipped: not invoicing is the intent there.
 *
 * Idempotent through `subscriptions.paused_notice_sent_at` (migration 0041):
 * a merchant notified inside `resendAfterDays` is skipped. A blocked user with
 * no subscription row at all cannot carry the marker — it is emailed and
 * reported with `marker_stored: false`, so a re-run is a conscious decision.
 */
export async function runSubscriptionPausedNotices(
  env: Env,
  opts: { dryRun?: boolean; userId?: string; minPending?: number; resendAfterDays?: number; lookbackDays?: number } = {},
): Promise<PausedNoticeResult> {
  const dryRun = opts.dryRun !== false; // sending is opt-in, never the default
  const minPending = opts.minPending ?? 1;
  const resendAfterDays = opts.resendAfterDays ?? 7;
  const lookbackDays = opts.lookbackDays ?? 90;
  const now = new Date();
  const nowIso = now.toISOString();
  const lookbackIso = new Date(now.getTime() - lookbackDays * 86_400_000).toISOString();

  const result: PausedNoticeResult = {
    checked: 0, sent: 0, failed: 0,
    skipped_no_pending: 0, skipped_recent_notice: 0, skipped_paused_shops: 0,
    dry_run: dryRun, candidates: [],
  };

  // Blocked exactly as checkSubscriptionGate decides it: no subscription row,
  // a dead status, or a trial with no Stripe sub and no live early-bird window.
  //
  // Since 0044 an account can hold one row per connection, so "blocked" is
  // "nothing on this account is live" — NOT EXISTS over the rows rather than a
  // condition on one of them. Joining the rows directly would have reported an
  // account as suspended because ONE of its two subscriptions had lapsed, and
  // emailed it once per row.
  const rows = await env.DB.prepare(
    `SELECT u.id                                                                      AS user_id,
            COALESCE(NULLIF(TRIM(s.email), ''), u.email)                              AS email,
            COALESCE(NULLIF(TRIM(s.name), ''), u.admin_label, u.company_name, u.name) AS name,
            s.status                                                                  AS status,
            s.paused_notice_sent_at                                                   AS marker,
            CASE WHEN s.user_id IS NULL THEN 0 ELSE 1 END                             AS has_sub_row,
            (SELECT COUNT(*) FROM integrations i WHERE i.user_id = u.id)                                AS int_total,
            (SELECT COUNT(*) FROM integrations i WHERE i.user_id = u.id AND COALESCE(i.is_paused,0) = 0) AS int_active
       FROM users u
       LEFT JOIN subscriptions s
              ON s.user_id = u.id
             AND s.connection_key = (SELECT MIN(x.connection_key) FROM subscriptions x WHERE x.user_id = u.id)
      WHERE COALESCE(u.role, 'user') NOT IN ('superadmin', 'hiperadmin')
        AND NOT EXISTS (
              SELECT 1 FROM subscriptions v
               WHERE v.user_id = u.id
                 AND v.status NOT IN ('canceled','unpaid','incomplete_expired','incomplete','past_due')
                 AND NOT (v.status = 'trialing'
                          AND v.stripe_subscription_id IS NULL
                          AND NOT (COALESCE(v.early_bird,0) = 1 AND v.trial_end IS NOT NULL AND datetime(v.trial_end) > datetime(?)))
        )`
  ).bind(nowIso).all();

  let blocked = (rows.results ?? []) as unknown as BlockedRow[];
  // A parked account is blocked on purpose and knows it: telling them again is
  // noise. See ./inactive-accounts.
  const parked = await loadInactiveUserIds(env);
  blocked = blocked.filter((b) => !parked.has(String(b.user_id)));
  if (opts.userId) blocked = blocked.filter((b) => String(b.user_id) === String(opts.userId));
  if (blocked.length === 0) return result;

  // Orders the gate turned away, per user, within the lookback window.
  const incidents = await env.DB.prepare(
    `SELECT i.user_id AS user_id, j.value AS order_id, i.first_seen_at AS seen_at
       FROM incidents i, json_each(i.affected_ids_json) j
      WHERE i.kind = 'subscription_inactive'
        AND i.first_seen_at >= ?`
  ).bind(lookbackIso).all();

  const byUser = new Map<string, { ids: Set<string>; since: string | null }>();
  for (const r of (incidents.results ?? []) as any[]) {
    const uid = String(r.user_id);
    const entry = byUser.get(uid) ?? { ids: new Set<string>(), since: null };
    entry.ids.add(String(r.order_id));
    const seen = r.seen_at ? String(r.seen_at) : null;
    if (seen && (!entry.since || seen < entry.since)) entry.since = seen;
    byUser.set(uid, entry);
  }

  // One batched check across processed_orders / reconciliation_match /
  // lodgify_partial_invoices: an order invoiced by any route is not pending.
  const allIds = [...new Set([...byUser.values()].flatMap((e) => [...e.ids]))];
  const invoiced = allIds.length ? await new AppStorage(env).getInvoicedOrderIdsAnySource(allIds) : new Set<string>();

  for (const b of blocked) {
    // A merchant whose shops are all paused chose not to invoice — no nag.
    if (b.int_total > 0 && b.int_active === 0) { result.skipped_paused_shops++; continue; }

    const entry = byUser.get(String(b.user_id));
    const pendingIds = entry ? [...entry.ids].filter((id) => !invoiced.has(id)) : [];
    if (pendingIds.length < minPending) { result.skipped_no_pending++; continue; }

    if (b.marker) {
      const age = (now.getTime() - new Date(b.marker).getTime()) / 86_400_000;
      if (Number.isFinite(age) && age < resendAfterDays) { result.skipped_recent_notice++; continue; }
    }

    result.checked++;
    const to = b.email ? [String(b.email)] : [];
    const recipients = to.length ? to : [OPS_EMAIL];
    const cc = to.length ? [OPS_EMAIL] : undefined;
    result.candidates.push({
      user_id: b.user_id,
      email: b.email,
      name: b.name,
      status: b.status,
      pending: pendingIds.length,
      since: entry?.since ?? null,
      would_email: [...recipients, ...(cc ?? [])],
      marker_stored: b.has_sub_row === 1,
    });
    if (dryRun) continue;

    const { subject, html } = pausedNoticeEmail(b.name, pendingIds.length, entry?.since ? ptDate(entry.since) : null);
    const res = await sendEmail(env, { to: recipients, cc, subject, html });
    if (res.ok) {
      result.sent++;
      if (b.has_sub_row === 1) {
        await env.DB.prepare(
          `UPDATE subscriptions SET paused_notice_sent_at = ?, updated_at = ? WHERE user_id = ?`
        ).bind(nowIso, nowIso, b.user_id).run();
      }
    } else {
      result.failed++;
      console.error(`[PausedNotice] send failed for ${b.user_id}: ${res.provider} ${res.detail ?? ""}`);
    }
  }

  return result;
}
