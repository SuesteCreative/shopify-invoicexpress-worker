import type { Env } from "../env";
import type { IRequestConfig } from "../storage";
import { sendEmail } from "./email";
import { renderQuotaEmail } from "./email-templates";
import { renderInTheme, renderInLang } from "./email-templates";
import { getUserTheme } from "./user-theme";
import { getUserLanguage } from "./user-language";
import { accountName } from "./account-label";
import { connectionPill } from "./platform-names";

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

async function merchant(env: Env, userId?: string | null): Promise<{ emails: string[]; name?: string; code?: string; pipe?: string }> {
  if (!userId) return { emails: [] };
  try {
    const row: any = await env.DB.prepare(
      `SELECT u.email AS email, u.name AS name, u.company_name AS company_name, u.admin_label AS admin_label,
              u.client_code AS client_code, i.dev_notify_emails AS dev, i.shopify_domain AS shopify_domain,
              -- Which platforms actually feed this account's InvoiceXpress. The
              -- chip used to read "Shopify → InvoiceXpress" for everybody, which
              -- is wrong for the Stripe and Lodgify merchants who also invoice
              -- through IX. An account can have more than one, so they are all
              -- named.
              (SELECT GROUP_CONCAT(DISTINCT c.source_kind)
                 FROM connections c
                WHERE c.user_id = u.id AND c.status = 'active'
                  AND c.destination_kind = 'invoicexpress') AS ix_sources
         FROM users u LEFT JOIN integrations i ON i.user_id = u.id
        WHERE u.id = ? LIMIT 1`
    ).bind(userId).first();
    const emails: string[] = [];
    if (row?.email) emails.push(String(row.email));
    if (row?.dev) { try { for (const e of JSON.parse(row.dev)) if (typeof e === "string") emails.push(e); } catch { /* ignore */ } }
    const valid = [...new Set(emails)].filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));

    // The legacy `integrations` row IS the Shopify pipe, and it has no row in
    // `connections` — but only when it names a shop. A row holding nothing but
    // IX credentials (which is what MeetFrank's was) is not an integration.
    const sources = String(row?.ix_sources ?? "").split(",").filter(Boolean);
    if (String(row?.shopify_domain ?? "").trim()) sources.push("shopify");

    // accountName, not row.company || row.name: `company_name` is often empty
    // and `name` is often the Clerk placeholder, which is how this subject line
    // could read "limite atingido (User)". See ./account-label.
    return {
      emails: valid,
      name: accountName(row),
      code: row?.client_code ? String(row.client_code) : undefined,
      pipe: connectionPill(sources, "invoicexpress"),
    };
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

    // Read before the render: both wrappers are synchronous by contract.
    const theme = await getUserTheme(env, config.user_id);
    const language = await getUserLanguage(env, config.user_id);
    const tpl = renderInLang(language, () => renderInTheme(theme, () => renderQuotaEmail({
      kind: "reached",
      merchantName: m.name || config.shopify_domain || account,
      clientCode: m.code,
      connectionLabel: m.pipe,
      ixAccount: account,
      periodStart: period.start,
      periodEnd: period.end,
    })));
    const res = await sendEmail(env, { to: recipients, subject: tpl.subject, html: tpl.html });
    if (res.ok) {
      try { await env.INVOICE_KV.put(key, new Date().toISOString(), { expirationTtl: 35 * 24 * 60 * 60 }); } catch { /* ignore */ }
    }
  } catch (e) {
    console.error("[Rioko] quota alert failed (non-fatal):", e);
  }
}
