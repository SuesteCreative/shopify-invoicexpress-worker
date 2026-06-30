import type { Env } from "../env";
import type { IRequestConfig } from "../storage";
import { sendEmail } from "./email";
import { renderQuotaEmail } from "./email-templates";

// True when an IX create error is the plan's document-quota limit, e.g.
// "Atingiu o limite de criação de documentos para o período de 2026-05-30 a 2026-06-30".
const QUOTA_RE = /atingiu o limite de cria|limite de cria[çc][ãa]o de documentos/i;
export function isQuotaLimitError(s: string | null | undefined): boolean {
  return QUOTA_RE.test(String(s ?? ""));
}

function parsePeriod(err: string): { start: string; end: string } {
  const m = String(err).match(/per[íi]odo de (\d{4}-\d{2}-\d{2}) a (\d{4}-\d{2}-\d{2})/i);
  const fmt = (iso?: string) => (iso ? iso.split("-").reverse().join("/") : "");
  return { start: fmt(m?.[1]), end: fmt(m?.[2]) };
}

async function merchant(env: Env, userId?: string | null): Promise<{ emails: string[]; name?: string }> {
  if (!userId) return { emails: [] };
  try {
    const row: any = await env.DB.prepare(
      "SELECT u.email AS email, u.name AS name, u.company_name AS company, i.dev_notify_emails AS dev FROM users u LEFT JOIN integrations i ON i.user_id = u.id WHERE u.id = ? LIMIT 1"
    ).bind(userId).first();
    const emails: string[] = [];
    if (row?.email) emails.push(String(row.email));
    if (row?.dev) { try { for (const e of JSON.parse(row.dev)) if (typeof e === "string") emails.push(e); } catch { /* ignore */ } }
    const valid = [...new Set(emails)].filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    return { emails: valid, name: row?.company || row?.name || undefined };
  } catch { return { emails: [] }; }
}

/**
 * When an invoice create fails because the merchant's InvoiceXpress plan hit its
 * document limit, email the merchant (once per account+period — KV-deduped) so
 * they can upgrade. CCs the ops team for visibility. Best-effort: never throws.
 * Wire ONLY into the live webhook path (handleOrderCreated), not admin/reemit,
 * so manual ops sweeps don't email merchants.
 */
export async function maybeSendQuotaReachedAlert(env: Env, config: IRequestConfig, ixErrorText: string): Promise<void> {
  try {
    if (!isQuotaLimitError(ixErrorText)) return;
    const account = config.ix_account_name ?? "";
    const period = parsePeriod(ixErrorText);
    const key = `quota-alert:${account}:${period.start || "x"}-${period.end || "x"}`;
    try { if (await env.INVOICE_KV.get(key)) return; } catch { /* ignore */ }

    const m = await merchant(env, config.user_id);
    const ops = (env.KAPTA_DEV_EMAILS ?? "").split(",").map(s => s.trim()).filter(Boolean);
    const recipients = [...new Set([...m.emails, ...ops])];
    if (recipients.length === 0) return;

    const tpl = renderQuotaEmail({
      kind: "reached",
      merchantName: m.name || config.shopify_domain || account,
      ixAccount: account,
      periodStart: period.start,
      periodEnd: period.end,
    });
    const res = await sendEmail(env, { to: recipients, subject: tpl.subject, html: tpl.html });
    if (res.ok) {
      try { await env.INVOICE_KV.put(key, new Date().toISOString(), { expirationTtl: 35 * 24 * 60 * 60 }); } catch { /* ignore */ }
    }
  } catch (e) {
    console.error("[Rioko] quota alert failed (non-fatal):", e);
  }
}
