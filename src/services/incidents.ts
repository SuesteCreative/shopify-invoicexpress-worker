import type { Env } from "../env";
import { AppStorage } from "../storage";
import { sendEmail } from "./email";
import { renderIncidentTemplate, tplPatternReport, type IncidentKind } from "./email-templates";
import { redactIncident, diagnoseIncident, summarizeIncidentPatterns, type IncidentDiagnosis, type RedactedIncident } from "./anthropic";

export type Severity = "info" | "warning" | "error" | "critical";

export interface ReportIncidentInput {
  user_id?: string | null;
  connection_id?: string | null;
  severity: Severity;
  kind: IncidentKind;
  summary: string;
  detail?: any;
  affected_ids?: Array<string | number>;
  /** Override the bucket window. Defaults to hourly grouping. */
  bucket?: "hourly" | "daily";
  /** Override the merchant label for emails (default: looked up from users table). */
  merchant_name?: string;
  /** Override the connection label for emails (e.g. "Stripe → InvoiceXpress"). */
  connection_label?: string;
  /** Human order reference for the email (e.g. "#1234"). */
  order_ref?: string;
  /** End-customer name for the email (e.g. "João Silva"). */
  client_name?: string;
  /**
   * Narrows the dedup bucket to a single subject (an invoice id, an order id).
   *
   * The default bucket is `user:kind:hour`, which is right for outage-shaped
   * failures — 200 orders failing on one expired token must not send 200
   * emails. It is wrong for per-document notices: two invoices held in the same
   * hour collapse into one bucket, and since the merchant email only fires on
   * the bucket's FIRST occurrence, the merchant is told about the first invoice
   * and never hears about the second. Passing the document id here gives each
   * one its own bucket, while still swallowing a re-delivered webhook for the
   * same document.
   */
  dedup_key?: string;
}

export interface IncidentRow {
  id: string;
  user_id: string | null;
  connection_id: string | null;
  bucket_key: string;
  severity: Severity;
  kind: IncidentKind;
  summary: string;
  detail_json: string | null;
  affected_ids_json: string | null;
  status: "open" | "acknowledged" | "resolved" | "auto_resolved";
  first_seen_at: string;
  last_seen_at: string;
  occurrences: number;
  notified_at: string | null;
  resolved_at: string | null;
}

export function bucketKeyFor(input: ReportIncidentInput, now: Date): string {
  const userPart = input.user_id ?? "none";
  const granularity = input.bucket ?? "hourly";
  const iso = now.toISOString();
  const bucketPart = granularity === "daily" ? iso.slice(0, 10) : iso.slice(0, 13); // YYYY-MM-DD or YYYY-MM-DD-HH (T as sep)
  // `dedup_key` splits the time bucket per subject — see ReportIncidentInput.
  const subjectPart = input.dedup_key ? `:${input.dedup_key}` : "";
  return `${userPart}:${input.kind}:${bucketPart}${subjectPart}`;
}

/**
 * Upserts an incident keyed by bucket_key. Within the same hour, repeated
 * identical failures bump `occurrences` and `last_seen_at`. Critical-severity
 * incidents email immediately on first occurrence (subsequent occurrences in
 * the same bucket do NOT re-email; the daily digest covers stragglers).
 */
export async function reportIncident(env: Env, input: ReportIncidentInput): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const bucketKey = bucketKeyFor(input, now);
  const id = crypto.randomUUID();
  const affectedJson = input.affected_ids ? JSON.stringify(input.affected_ids.map(String)) : null;
  const detailJson = input.detail != null ? JSON.stringify(input.detail) : null;

  let wasNew = false;
  let notifyNow = false;

  try {
    const result = await env.DB.prepare(
      `INSERT INTO incidents (id, user_id, connection_id, bucket_key, severity, kind, summary, detail_json, affected_ids_json, status, first_seen_at, last_seen_at, occurrences, notified_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 1, NULL, NULL)
       ON CONFLICT(bucket_key) DO UPDATE SET
         occurrences = incidents.occurrences + 1,
         last_seen_at = excluded.last_seen_at,
         summary = excluded.summary,
         -- Escalate, never downgrade. The bucket keeps whichever severity is
         -- highest for the hour: a generic 429 opening the bucket must not mask
         -- the critical that follows it (a permanent Lodgify IP block landed as
         -- "error" purely because a lesser incident got there first).
         severity = CASE
           WHEN (CASE excluded.severity  WHEN 'critical' THEN 4 WHEN 'error' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END)
              > (CASE incidents.severity WHEN 'critical' THEN 4 WHEN 'error' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END)
           THEN excluded.severity ELSE incidents.severity END,
         detail_json = COALESCE(excluded.detail_json, incidents.detail_json),
         affected_ids_json = CASE
           WHEN excluded.affected_ids_json IS NULL THEN incidents.affected_ids_json
           WHEN incidents.affected_ids_json IS NULL THEN excluded.affected_ids_json
           ELSE incidents.affected_ids_json
         END,
         status = CASE WHEN incidents.status = 'resolved' THEN 'open' ELSE incidents.status END,
         resolved_at = CASE WHEN incidents.status = 'resolved' THEN NULL ELSE incidents.resolved_at END
       RETURNING occurrences = 1 AS was_new,
                 (notified_at IS NULL AND severity = 'critical') AS notify_now`
    ).bind(
      id,
      input.user_id ?? null,
      input.connection_id ?? null,
      bucketKey,
      input.severity,
      input.kind,
      input.summary,
      detailJson,
      affectedJson,
      nowIso,
      nowIso,
    ).first();
    wasNew = !!(result as any)?.was_new;
    // True when the bucket now stands at critical and no email has gone out for
    // it yet — covers a fresh critical, one that escalated into an existing
    // bucket, and a retry after a send that failed.
    notifyNow = !!(result as any)?.notify_now;
  } catch (e: any) {
    console.error(`[incidents] Failed to upsert: ${e.message}`);
    return;
  }

  // Email immediately on first occurrence of critical incidents AND of any
  // "order not invoiced" failure (even if a caller didn't mark it critical), so
  // ops are alerted in real time instead of waiting for the Friday digest.
  if ((wasNew && (input.severity === "critical" || REALTIME_OPS_ALERT_KINDS.has(input.kind))) || notifyNow) {
    // P3 suppression: when destination auth fails (expired Moloni/IX token),
    // every queued order in the next hour creates a NEW bucket → fresh critical
    // email. The merchant only needs one ping to re-auth. Suppress repeats
    // within a 24h window of the last *notified* incident of the same kind for
    // the same user; the daily digest still captures any stragglers.
    let suppressEmail = false;
    if (input.kind === "auth_failure_destination" && input.user_id) {
      try {
        const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const prior = await env.DB.prepare(
          `SELECT 1 FROM incidents
           WHERE user_id = ? AND kind = ? AND notified_at IS NOT NULL
             AND notified_at >= ?
             AND status IN ('open', 'acknowledged')
           LIMIT 1`
        ).bind(input.user_id, input.kind, cutoffIso).first();
        if (prior) suppressEmail = true;
      } catch (e: any) {
        // Don't block the email path on a SELECT failure.
        console.warn(`[incidents] auth-failure suppression lookup failed: ${e.message}`);
      }
    }

    if (!suppressEmail) {
      try {
        await emailIncident(env, input, bucketKey, nowIso, nowIso);
        await env.DB.prepare(
          "UPDATE incidents SET notified_at = ? WHERE bucket_key = ? AND notified_at IS NULL"
        ).bind(nowIso, bucketKey).run();
      } catch (e: any) {
        console.error(`[incidents] Critical email failed: ${e.message}`);
      }
    }
  }

  // Merchant-facing notice, deliberately narrow. The ops alert above stays
  // internal (merchants were once flooded by per-failure email), but a held
  // invoice caused by data only the merchant can correct is useless to them as
  // a Friday digest line — they need it while the order is fresh. One email per
  // incident bucket, so a burst of bad orders in the same hour is one message.
  if (wasNew && MERCHANT_ACTIONABLE_KINDS.has(input.kind)) {
    try {
      await emailMerchantActionNeeded(env, input);
    } catch (e: any) {
      console.error(`[incidents] Merchant notice failed: ${e.message}`);
    }
  }
}

/**
 * Failures the merchant — not us — has to resolve, and that block an invoice
 * until they do. Keep this set very small; everything else belongs in the
 * weekly digest.
 */
const MERCHANT_ACTIONABLE_KINDS = new Set<IncidentKind>([
  "nif_invalid",
  "nif_invalid_draft",
  // A refund landed on a document that is still a draft. No credit note is
  // possible; the merchant edits or deletes the draft. Money has already gone
  // back to the buyer, so this should not wait for the Friday digest.
  "credit_note_on_draft",
]);

/** The two kinds that share the bespoke address-line-NIF notice. Everything
 *  else in MERCHANT_ACTIONABLE_KINDS renders from its own incident template. */
const NIF_NOTICE_KINDS = new Set<IncidentKind>(["nif_invalid", "nif_invalid_draft"]);

async function emailMerchantActionNeeded(env: Env, input: ReportIncidentInput): Promise<void> {
  const recipients = [...new Set(await resolveMerchantEmails(env, input.user_id))];
  if (recipients.length === 0) {
    console.warn(`[incidents] No merchant recipient for ${input.kind} (user ${input.user_id ?? "unknown"})`);
    return;
  }

  const now = new Date().toISOString();
  const { subject, html } = NIF_NOTICE_KINDS.has(input.kind)
    ? renderMerchantActionNeeded(input)
    : renderIncidentTemplate(input.kind, {
      occurrences: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      summary: input.summary,
      detail: input.detail,
      orderRef: input.order_ref,
      clientName: input.client_name,
      connectionLabel: input.connection_label,
      merchantName: input.merchant_name,
      affectedIds: input.affected_ids?.map(String),
      severity: input.severity,
    });

  await sendEmail(env, { to: recipients, subject, html });
}

/**
 * The merchant-facing notice, as a pure function so its wording can be tested
 * without a mail provider or a database. This is the message the shop owner
 * actually receives — the incident template of the same kind is only used by
 * the digest and the preview route.
 */
export function renderMerchantActionNeeded(input: ReportIncidentInput): { subject: string; html: string } {
  const detail = (input.detail ?? {}) as Record<string, any>;
  const orderRef = input.order_ref ?? detail.orderRef ?? null;
  const client = input.client_name ?? detail.clientName ?? null;
  const found = detail.raw ?? detail.invalidNif ?? null;
  const orderLabel = orderRef ? `A encomenda <strong>${orderRef}</strong>` : "Uma encomenda";

  // Two outcomes share this notice, and the merchant has to do different things
  // in each: `nif_invalid_draft` means the document EXISTS as a draft and needs
  // reviewing; `nif_invalid` means nothing was issued at all.
  const isDraft = input.kind === "nif_invalid_draft";
  const invoiceId = detail.invoiceId ?? detail.invoice_id ?? null;
  const permalink = typeof detail.permalink === "string" ? detail.permalink : null;
  const invoiceLabel = invoiceId ? `A factura <strong>${invoiceId}</strong>` : "A factura";

  const subject = isDraft
    ? (orderRef
      ? `Factura de ${orderRef} ficou em rascunho (NIF inválido)`
      : "Uma factura ficou em rascunho (NIF inválido)")
    : (orderRef
      ? `Ação necessária: ${orderRef} não foi faturada (NIF inválido)`
      : "Ação necessária: uma encomenda não foi faturada (NIF inválido)");

  const headline = isDraft
    ? `${invoiceLabel}${orderRef ? `, referente a ${orderRef},` : ""} ficou em rascunho.`
    : `${orderLabel} não foi faturada.`;

  const consequence = isDraft
    ? `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#3c4a5c;">
          Emitimos a factura <strong>sem esse número e em rascunho</strong>, para que a decisão seja tua.
          Nada foi comunicado à AT e o cliente não recebeu nada.
        </p>`
    : `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#3c4a5c;">
          Como emitir uma fatura com um contribuinte errado não tem retorno, preferimos não a emitir.
          A encomenda ficou em espera.
        </p>`;

  const steps = isDraft
    ? `1. Confirma o NIF com o cliente.<br/>
            2. Corrige a morada da encomenda no Shopify — ou apaga o valor, se afinal não era um NIF.<br/>
            3. Reemite a partir do painel Rioko: o rascunho é substituído.<br/>
            4. Se o cliente não quer NIF, finaliza o rascunho como está (Consumidor Final).`
    : `1. Confirma o NIF com o cliente.<br/>
            2. Corrige a morada da encomenda no Shopify — ou apaga o valor, se afinal não era um NIF.<br/>
            3. Reemite a fatura a partir do painel Rioko.`;

  const badge = isDraft ? "Em rascunho" : "Ação necessária";

  const html = `<!-- merchant action needed · ${input.kind} -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f8fa;margin:0;padding:32px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid #e3e8ee;border-radius:18px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      <tr><td style="height:4px;background:#c2410c;font-size:0;line-height:0;">&nbsp;</td></tr>
      <tr><td style="padding:30px 36px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="font-size:15px;font-weight:700;letter-spacing:-0.01em;color:#0b1524;padding-right:10px;">Rioko</td>
          <td style="font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#c2410c;background:#fdf0e8;border-radius:999px;padding:4px 10px;">${badge}</td>
        </tr></table>
        <h1 style="margin:20px 0 14px;font-size:21px;line-height:1.32;font-weight:650;letter-spacing:-0.02em;color:#0b1524;">${headline}</h1>
        <p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#3c4a5c;">
          No endereço${client ? ` de <strong>${client}</strong>` : ""} encontrámos ${found ? `<strong>${found}</strong>` : "um valor"}
          no campo de segunda linha de morada. Parece um contribuinte, mas não é um NIF português válido.
        </p>
        ${consequence}
      </td></tr>
      <tr><td style="padding:6px 36px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fafbfc;border:1px solid #eceff3;border-radius:12px;">
          <tr><td style="padding:16px;font-size:14px;line-height:1.7;color:#3c4a5c;">
            <strong style="color:#0b1524;">O que fazer</strong><br/>
            ${steps}
          </td></tr>
        </table>
      </td></tr>
      ${permalink ? `<tr><td style="padding:18px 36px 0;">
        <a href="${permalink}" style="display:inline-block;background:#0b1524;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:11px 22px;border-radius:10px;">Ver rascunho</a>
      </td></tr>` : ""}
      <tr><td style="padding:24px 36px 32px;">
        <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#5b6879;">
          Se preferires que tratemos disto, responde a este email.
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

async function emailIncident(env: Env, input: ReportIncidentInput, bucketKey: string, firstSeenAt: string, lastSeenAt: string) {
  // Real-time critical alerts go to the Rioko/Kapta team ONLY. Merchants were
  // being flooded by per-failure emails (every new bucket = a fresh email), so
  // their inbox is now served exclusively by the weekly Friday digest
  // (runWeeklyMerchantDigest) which lists only their own still-unprocessed
  // invoices. Do NOT add merchant emails back here.
  const devEmails = parseEmailList(env.KAPTA_DEV_EMAILS);
  const recipients = [...new Set(devEmails)];
  if (recipients.length === 0) {
    console.warn(`[incidents] No dev recipients for critical incident ${bucketKey} (set KAPTA_DEV_EMAILS)`);
    return;
  }

  const merchantName = input.merchant_name ?? await resolveMerchantName(env, input.user_id);

  // Optional, advisory AI triage. Fail-open: any failure => undefined => the email
  // renders exactly as before (static "Causa provável" only). Only order-level kinds,
  // and only here (the wasNew real-time path) — so it's one paid call per
  // user:kind:hour bucket; the diagnosis is KV-cached by bucketKey for retries.
  let aiDiagnosis: string | undefined;
  let aiSuggestedFix: string | undefined;
  if (AI_TRIAGE_ORDER_KINDS.has(input.kind)) {
    try {
      const diag = await diagnoseIncident(env, redactIncident(input), bucketKey);
      if (diag) { aiDiagnosis = diag.diagnosis; aiSuggestedFix = diag.suggested_fix; }
    } catch (e: any) {
      console.warn(`[incidents] AI triage failed (advisory, ignored): ${e?.message ?? e}`);
    }
  }

  const tpl = renderIncidentTemplate(input.kind, {
    merchantName,
    connectionLabel: input.connection_label,
    occurrences: 1,
    firstSeenAt,
    lastSeenAt,
    summary: input.summary,
    detail: input.detail,
    affectedIds: input.affected_ids?.map(String),
    severity: input.severity,
    orderRef: input.order_ref,
    clientName: input.client_name,
    aiDiagnosis,
    aiSuggestedFix,
  });

  await sendEmail(env, { to: recipients, subject: tpl.subject, html: tpl.html });
}

// Rebuild a triage input from a persisted incident row (kind + detail_json) so
// redaction reads the same shape the live email path produced.
function incidentRowToInput(row: any): ReportIncidentInput {
  let detail: any = {};
  try { detail = row.detail_json ? JSON.parse(row.detail_json) : {}; } catch { /* leave empty */ }
  return {
    user_id: row.user_id,
    severity: (row.severity as Severity) ?? "critical",
    kind: row.kind,
    summary: row.summary,
    detail,
    connection_label: detail.source && detail.destination ? `${detail.source} → ${detail.destination}` : undefined,
    order_ref: detail.orderRef,
    client_name: detail.clientName,
  };
}

/**
 * On-demand advisory diagnosis for any incident by id (Phase 2 admin endpoint).
 * Reconstructs the triage input from the persisted row and runs the same redact +
 * diagnose path as the real-time email. Advisory only.
 */
export async function explainIncidentById(
  env: Env,
  id: string,
): Promise<{ ok: true; diagnosis: IncidentDiagnosis } | { ok: false; error: string }> {
  let row: any;
  try {
    row = await env.DB.prepare(
      "SELECT id, user_id, kind, severity, summary, detail_json, bucket_key FROM incidents WHERE id = ?",
    ).bind(id).first();
  } catch (e: any) {
    return { ok: false, error: `lookup failed: ${e?.message ?? e}` };
  }
  if (!row) return { ok: false, error: "incident not found" };

  const diag = await diagnoseIncident(env, redactIncident(incidentRowToInput(row)), row.bucket_key ?? `explain:${id}`);
  if (!diag) return { ok: false, error: "no diagnosis (feature disabled, hourly cap reached, or model error)" };
  return { ok: true, diagnosis: diag };
}

/**
 * Re-send the real alert email for an existing incident (QA/preview). Runs the
 * full live path — AI triage + render + send to KAPTA_DEV_EMAILS — without
 * touching the incident row. Lets ops eyeball the finished email (incl. the AI
 * "Diagnóstico (IA)" block) on demand.
 */
export async function sendIncidentTestEmail(
  env: Env,
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  let row: any;
  try {
    row = await env.DB.prepare(
      "SELECT id, user_id, kind, severity, summary, detail_json, bucket_key, first_seen_at, last_seen_at FROM incidents WHERE id = ?",
    ).bind(id).first();
  } catch (e: any) {
    return { ok: false, error: `lookup failed: ${e?.message ?? e}` };
  }
  if (!row) return { ok: false, error: "incident not found" };
  try {
    await emailIncident(env, incidentRowToInput(row), row.bucket_key ?? `test:${id}`, row.first_seen_at, row.last_seen_at);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: `send failed: ${e?.message ?? e}` };
  }
}

/**
 * Weekly AI cross-incident pattern report (Phase 3). Collects the week's
 * order-level incidents, redacts them, asks Claude for systemic patterns, and
 * emails an ops summary to KAPTA_DEV_EMAILS. Gated by the caller. No-op (returns
 * null result) when the feature key is unset or nothing is found.
 */
export async function runWeeklyPatternReport(
  env: Env,
): Promise<{ ok: boolean; totalIncidents: number; patterns: number }> {
  const cutoffIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const kinds = [...AI_TRIAGE_ORDER_KINDS];
  const placeholders = kinds.map(() => "?").join(",");

  let rows: any[] = [];
  try {
    const result = await env.DB.prepare(
      `SELECT id, user_id, kind, severity, summary, detail_json, bucket_key
       FROM incidents
       WHERE last_seen_at >= ? AND kind IN (${placeholders})
       ORDER BY last_seen_at DESC LIMIT 300`,
    ).bind(cutoffIso, ...kinds).all();
    rows = (result.results ?? []) as any[];
  } catch (e: any) {
    console.error(`[pattern-report] incident query failed: ${e.message}`);
    return { ok: false, totalIncidents: 0, patterns: 0 };
  }
  if (rows.length === 0) return { ok: true, totalIncidents: 0, patterns: 0 };

  const redacted: RedactedIncident[] = rows.map((r) => redactIncident(incidentRowToInput(r)));
  const report = await summarizeIncidentPatterns(env, redacted);
  if (!report) return { ok: false, totalIncidents: rows.length, patterns: 0 };

  const recipients = parseEmailList(env.KAPTA_DEV_EMAILS);
  if (recipients.length > 0) {
    const weekLabel = `${cutoffIso.slice(0, 10)} → ${new Date().toISOString().slice(0, 10)}`;
    const tpl = tplPatternReport({
      summary: report.summary,
      patterns: report.patterns,
      totalIncidents: rows.length,
      weekLabel,
    });
    await sendEmail(env, { to: recipients, subject: tpl.subject, html: tpl.html });
  }
  return { ok: true, totalIncidents: rows.length, patterns: report.patterns.length };
}

async function resolveMerchantEmails(env: Env, userId?: string | null): Promise<string[]> {
  if (!userId) return [];
  try {
    // Look at the integrations row's dev_notify_emails JSON column, plus the user's own email.
    const row: any = await env.DB.prepare(
      "SELECT u.email AS user_email, i.dev_notify_emails FROM users u LEFT JOIN integrations i ON i.user_id = u.id WHERE u.id = ?"
    ).bind(userId).first();
    if (!row) return [];
    const out: string[] = [];
    if (row.user_email) out.push(String(row.user_email));
    if (row.dev_notify_emails) {
      try {
        const arr = JSON.parse(row.dev_notify_emails);
        if (Array.isArray(arr)) {
          for (const e of arr) if (typeof e === "string") out.push(e);
        }
      } catch { /* ignore */ }
    }
    return out;
  } catch (e: any) {
    console.error(`[incidents] Failed to resolve merchant emails: ${e.message}`);
    return [];
  }
}

async function resolveMerchantName(env: Env, userId?: string | null): Promise<string | undefined> {
  if (!userId) return undefined;
  try {
    const row: any = await env.DB.prepare("SELECT name FROM users WHERE id = ?").bind(userId).first();
    return row?.name ?? undefined;
  } catch {
    return undefined;
  }
}

function parseEmailList(s: string | undefined): string[] {
  if (!s) return [];
  return s.split(",").map(x => x.trim()).filter(x => x.length > 0);
}

/**
 * Daily digest: groups open + not-yet-notified incidents per user, sends one
 * email per merchant, marks `notified_at`. Also auto-resolves stale incidents
 * (no recurrence in 24h).
 */
export async function runIncidentDigest(env: Env): Promise<{ digestsSent: number; autoResolved: number }> {
  const nowIso = new Date().toISOString();
  const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // 1. Auto-resolve stale incidents (last_seen older than 24h, still open).
  const resolveResult = await env.DB.prepare(
    "UPDATE incidents SET status = 'auto_resolved', resolved_at = ? WHERE status = 'open' AND last_seen_at < ?"
  ).bind(nowIso, cutoffIso).run();
  const autoResolved = (resolveResult as any).meta?.changes ?? 0;

  // 2. Group remaining open un-notified incidents by user_id.
  const rows = await env.DB.prepare(
    `SELECT id, user_id, connection_id, bucket_key, severity, kind, summary, occurrences, last_seen_at
     FROM incidents
     WHERE status = 'open' AND notified_at IS NULL
     ORDER BY user_id, severity DESC, last_seen_at DESC`
  ).all();

  const byUser = new Map<string, any[]>();
  for (const row of (rows.results ?? []) as any[]) {
    const key = row.user_id ?? "_none";
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key)!.push(row);
  }

  let digestsSent = 0;
  for (const [userKey, incidents] of byUser) {
    const userId = userKey === "_none" ? null : userKey;
    const recipients = userId ? await resolveMerchantEmails(env, userId) : parseEmailList(env.KAPTA_DEV_EMAILS);
    if (recipients.length === 0) continue;

    const merchantName = userId ? await resolveMerchantName(env, userId) : "Kapta team";
    const { tplDigest } = await import("./email-templates");
    const tpl = tplDigest({
      merchantName,
      incidents: incidents.map(i => ({
        kind: i.kind,
        summary: i.summary,
        occurrences: i.occurrences,
        lastSeenAt: i.last_seen_at,
        severity: i.severity,
        connectionLabel: undefined,
      })),
    });

    const result = await sendEmail(env, { to: recipients, subject: tpl.subject, html: tpl.html });
    if (result.ok) {
      const ids = incidents.map(i => i.id);
      // Use parameterized list — D1 doesn't support array bind, so build placeholders.
      const placeholders = ids.map(() => "?").join(",");
      await env.DB.prepare(
        `UPDATE incidents SET notified_at = ? WHERE id IN (${placeholders})`
      ).bind(nowIso, ...ids).run();
      digestsSent++;
    }
  }

  return { digestsSent, autoResolved };
}

// ──────────────────────────────────────────────────────────────────────────
// Weekly per-merchant digest of still-unprocessed invoices
// ──────────────────────────────────────────────────────────────────────────

/**
 * Invoice-failure incident kinds — the ones that mean a sale was received but
 * no invoice got issued. Config/security kinds (webhook_invalid_signature,
 * auth_failure_*, vies_unconfirmed, reconcile_drift's siblings) are deliberately
 * excluded: the merchant's weekly email is about *missing invoices*, not
 * infrastructure alerts (those go to the Rioko team in real time).
 */
export const INVOICE_FAILURE_KINDS: IncidentKind[] = [
  "queue_retry_exhausted",
  "destination_reject",
  "normalize_fail",
  "nif_invalid",
  "currency_not_supported",
  "reconcile_drift",
  "subscription_inactive",
];

/** Failure kinds that mean "an order did NOT get invoiced". These fire an
 * immediate alert to the Rioko/Kapta team (never merchants), not just the weekly
 * Friday digest — the gap that let the zoolagos incident be discovered by the
 * client first. Bucket dedup (one row per user:kind:hour) keeps it to one email
 * per hour even during a 200-order outage. */
const REALTIME_OPS_ALERT_KINDS = new Set<IncidentKind>([
  "queue_retry_exhausted",
  "destination_reject",
  "nif_invalid",
  // An order whose line totals can't be reproduced exactly in IX is refused by
  // the reconcile guard (never ship a wrong total) — alert immediately so it's
  // fixed/handled, not left unbilled until Friday.
  "reconcile_drift",
]);

// Order-level kinds eligible for advisory AI triage in the real-time alert email.
// These carry a `detail` payload (error message / line math) the model can reason
// over. Account-level kinds (auth_failure_*, subscription_inactive, webhook_*) are
// excluded — there's nothing order-specific to diagnose.
const AI_TRIAGE_ORDER_KINDS = new Set<IncidentKind>([
  "reconcile_drift",
  "destination_reject",
  "queue_retry_exhausted",
  "nif_invalid",
  "currency_not_supported",
]);

/** Only surface incidents seen within this window; older misses are noise. */
const WEEKLY_LOOKBACK_DAYS = 90;

export interface WeeklyDigestItem {
  kind: IncidentKind;
  summary: string;
  lastSeenAt: string;
  severity?: Severity;
  /** Affected order/payment ids still missing an invoice (empty for account-level). */
  missingIds: string[];
}

export interface WeeklyDigestResult {
  merchantsNotified: number;
  totalMissing: number;
  skippedNoEmail: number;
  /** On dryRun: the per-merchant breakdown that WOULD be sent (nothing sent). */
  preview?: Array<{ userId: string; merchantName: string; recipients: string[]; missingCount: number; subject: string }>;
}

function parseAffectedIds(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Weekly per-merchant digest of STILL-unprocessed invoices.
 *
 * Candidates = invoice-failure incidents (see INVOICE_FAILURE_KINDS) that are
 * still open/acknowledged and were seen within WEEKLY_LOOKBACK_DAYS. Each
 * candidate's affected order ids are verified against `processed_orders`: any
 * order that has since been invoiced (self-heal or manual re-emit) is dropped,
 * and an incident whose ids are all resolved is removed entirely. Survivors are
 * grouped by user_id and ONE email is sent per merchant containing ONLY their
 * own missing invoices ("they can only get their own missing invoices"). The
 * Rioko team (KAPTA_DEV_EMAILS) is BCC'd on every send.
 *
 * Stateless re notified_at: this is a recurring weekly reminder, so it neither
 * reads nor writes notified_at — it recomputes from open incidents + the
 * ground-truth processed_orders table on each run, which makes it
 * self-correcting (a re-emitted order silently drops off next Friday).
 */
export async function runWeeklyMerchantDigest(env: Env, opts: { dryRun?: boolean; userId?: string } = {}): Promise<WeeklyDigestResult> {
  const empty: WeeklyDigestResult = { merchantsNotified: 0, totalMissing: 0, skippedNoEmail: 0, preview: [] };
  const cutoffIso = new Date(Date.now() - WEEKLY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const kindPlaceholders = INVOICE_FAILURE_KINDS.map(() => "?").join(",");

  let rows: any[] = [];
  try {
    const result = await env.DB.prepare(
      `SELECT id, user_id, kind, summary, occurrences, last_seen_at, severity, affected_ids_json
       FROM incidents
       WHERE status IN ('open','acknowledged')
         AND user_id IS NOT NULL
         AND last_seen_at >= ?
         AND kind IN (${kindPlaceholders})
       ORDER BY user_id, last_seen_at DESC`
    ).bind(cutoffIso, ...INVOICE_FAILURE_KINDS).all();
    rows = (result.results ?? []) as any[];
  } catch (e: any) {
    console.error(`[weekly-digest] incident query failed: ${e.message}`);
    return empty;
  }

  if (rows.length === 0) return empty;

  // Optional scope to a single merchant (manual trigger / targeted preview).
  if (opts.userId) {
    rows = rows.filter((r) => String(r.user_id) === String(opts.userId));
    if (rows.length === 0) return empty;
  }

  // Verify against ALL invoice-mapping tables in one batched lookup: an affected
  // id counts as invoiced if it has an invoice in processed_orders,
  // reconciliation_match (manual re-emit), OR lodgify_partial_invoices. Checking
  // only processed_orders (the old behaviour) left orders resolved by a manual
  // match or Lodgify partial counted as "missing" forever — the main driver of
  // the inflated "faturas por emitir" numbers.
  const allAffected = new Set<string>();
  for (const r of rows) for (const id of parseAffectedIds(r.affected_ids_json)) allAffected.add(id);
  const processed = await new AppStorage(env).getInvoicedOrderIdsAnySource([...allAffected]);

  const byUser = new Map<string, WeeklyDigestItem[]>();
  const resolvedIncidentIds: string[] = []; // fully-invoiced incidents to auto-close
  for (const r of rows) {
    const affected = parseAffectedIds(r.affected_ids_json);
    // Order-scoped incident: keep only the ids still missing an invoice.
    // Account-level incident (no affected ids, e.g. subscription_inactive):
    // can't verify per order, so always keep it.
    const missing = affected.filter((id) => !processed.has(id));
    if (affected.length > 0 && missing.length === 0) {
      // Every affected order now has an invoice — close the incident so it stops
      // recurring in future digests instead of just skipping it this run.
      resolvedIncidentIds.push(String(r.id));
      continue;
    }
    const userId = String(r.user_id);
    if (!byUser.has(userId)) byUser.set(userId, []);
    byUser.get(userId)!.push({
      kind: r.kind,
      summary: r.summary,
      lastSeenAt: r.last_seen_at,
      severity: r.severity,
      missingIds: missing,
    });
  }

  // Auto-close incidents whose affected orders are now ALL invoiced, so a
  // resolved-elsewhere miss stops re-surfacing every Friday. We mark 'resolved'
  // (not 'auto_resolved') on purpose: reportIncident's ON CONFLICT reopens a
  // 'resolved' bucket to 'open' if the SAME failure genuinely recurs, so closing
  // here can never swallow a future real miss. Best-effort + chunked; a failure
  // only means the incident lingers one more week.
  if (!opts.dryRun && resolvedIncidentIds.length > 0) {
    const nowIso = new Date().toISOString();
    for (let i = 0; i < resolvedIncidentIds.length; i += 50) {
      const chunk = resolvedIncidentIds.slice(i, i + 50);
      const ph = chunk.map(() => "?").join(",");
      try {
        await env.DB.prepare(
          `UPDATE incidents SET status = 'resolved', resolved_at = ?
           WHERE status IN ('open','acknowledged') AND id IN (${ph})`
        ).bind(nowIso, ...chunk).run();
      } catch (e: any) {
        console.error(`[weekly-digest] auto-close failed: ${e.message}`);
      }
    }
  }

  if (byUser.size === 0) return empty;

  // Skip merchants whose shops are ALL paused: a paused integration isn't being
  // invoiced on purpose, so a "faturas por emitir" nag is wrong. We only skip a
  // user who HAS integration rows and every one of them is paused — a user with
  // no integration row (e.g. a different source) is left untouched.
  const usersWithIntegrations = new Set<string>();
  const activeUsers = new Set<string>();
  {
    const userIds = [...byUser.keys()];
    for (let i = 0; i < userIds.length; i += 50) {
      const chunk = userIds.slice(i, i + 50);
      const ph = chunk.map(() => "?").join(",");
      try {
        const res = await env.DB.prepare(
          `SELECT user_id, COALESCE(is_paused,0) AS is_paused FROM integrations WHERE user_id IN (${ph})`
        ).bind(...chunk).all();
        for (const r of res.results as any[]) {
          usersWithIntegrations.add(String(r.user_id));
          if (Number(r.is_paused) === 0) activeUsers.add(String(r.user_id));
        }
      } catch (e: any) {
        console.error(`[weekly-digest] paused-shop lookup failed: ${e.message}`);
      }
    }
  }

  const devEmails = parseEmailList(env.KAPTA_DEV_EMAILS);
  const { tplWeeklyUnprocessed } = await import("./email-templates");
  let merchantsNotified = 0;
  let totalMissing = 0;
  let skippedNoEmail = 0;
  let skippedPaused = 0;
  const preview: WeeklyDigestResult["preview"] = [];

  for (const [userId, items] of byUser) {
    // Paused-only merchant → don't nag about invoices they intentionally aren't issuing.
    if (usersWithIntegrations.has(userId) && !activeUsers.has(userId)) {
      console.log(`[weekly-digest] user ${userId} has only paused shop(s); skipping (${items.length} item(s))`);
      skippedPaused++;
      continue;
    }
    // Strict isolation: resolve recipients per user so a merchant can only ever
    // receive their own list.
    const recipients = await resolveMerchantEmails(env, userId);
    if (recipients.length === 0) {
      console.warn(`[weekly-digest] No merchant email for user ${userId}; skipping (${items.length} item(s))`);
      skippedNoEmail++;
      continue;
    }

    // Count unique missing orders + account-level items so the headline number
    // doesn't double-count an order that appears in two incidents.
    const uniqueOrders = new Set<string>();
    let accountLevel = 0;
    for (const it of items) {
      if (it.missingIds.length) it.missingIds.forEach((id) => uniqueOrders.add(id));
      else accountLevel++;
    }
    const missingCount = uniqueOrders.size + accountLevel;

    const merchantName = await resolveMerchantName(env, userId);
    const tpl = tplWeeklyUnprocessed({ merchantName, items, totalMissing: missingCount });

    // Dry-run: record what WOULD be sent, send nothing.
    if (opts.dryRun) {
      // resolveMerchantName returns undefined for a user with no registered
      // label; the preview row wants a displayable string.
      preview!.push({ userId, merchantName: merchantName ?? userId, recipients, missingCount, subject: tpl.subject });
      merchantsNotified++;
      totalMissing += missingCount;
      continue;
    }

    const result = await sendEmail(env, {
      to: recipients,
      bcc: devEmails.length ? devEmails : undefined,
      subject: tpl.subject,
      html: tpl.html,
    });
    if (result.ok) {
      merchantsNotified++;
      totalMissing += missingCount;
    } else {
      console.error(`[weekly-digest] send failed for user ${userId}: ${result.detail ?? result.provider}`);
    }
  }

  if (skippedPaused) console.log(`[weekly-digest] skipped ${skippedPaused} paused-only merchant(s)`);
  return { merchantsNotified, totalMissing, skippedNoEmail, preview };
}
