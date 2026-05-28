import type { Env } from "../env";
import { sendEmail } from "./email";
import { renderIncidentTemplate, type IncidentKind } from "./email-templates";

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

function bucketKeyFor(input: ReportIncidentInput, now: Date): string {
  const userPart = input.user_id ?? "none";
  const granularity = input.bucket ?? "hourly";
  const iso = now.toISOString();
  const bucketPart = granularity === "daily" ? iso.slice(0, 10) : iso.slice(0, 13); // YYYY-MM-DD or YYYY-MM-DD-HH (T as sep)
  return `${userPart}:${input.kind}:${bucketPart}`;
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

  try {
    const result = await env.DB.prepare(
      `INSERT INTO incidents (id, user_id, connection_id, bucket_key, severity, kind, summary, detail_json, affected_ids_json, status, first_seen_at, last_seen_at, occurrences, notified_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 1, NULL, NULL)
       ON CONFLICT(bucket_key) DO UPDATE SET
         occurrences = incidents.occurrences + 1,
         last_seen_at = excluded.last_seen_at,
         summary = excluded.summary,
         detail_json = COALESCE(excluded.detail_json, incidents.detail_json),
         affected_ids_json = CASE
           WHEN excluded.affected_ids_json IS NULL THEN incidents.affected_ids_json
           WHEN incidents.affected_ids_json IS NULL THEN excluded.affected_ids_json
           ELSE incidents.affected_ids_json
         END,
         status = CASE WHEN incidents.status = 'resolved' THEN 'open' ELSE incidents.status END,
         resolved_at = CASE WHEN incidents.status = 'resolved' THEN NULL ELSE incidents.resolved_at END
       RETURNING occurrences = 1 AS was_new`
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
  } catch (e: any) {
    console.error(`[incidents] Failed to upsert: ${e.message}`);
    return;
  }

  // Email immediately on first occurrence of critical incidents.
  if (input.severity === "critical" && wasNew) {
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
}

async function emailIncident(env: Env, input: ReportIncidentInput, bucketKey: string, firstSeenAt: string, lastSeenAt: string) {
  const merchantEmails = await resolveMerchantEmails(env, input.user_id);
  const devEmails = parseEmailList(env.KAPTA_DEV_EMAILS);
  const recipients = [...new Set([...merchantEmails, ...devEmails])];
  if (recipients.length === 0) {
    console.warn(`[incidents] No recipients for critical incident ${bucketKey}`);
    return;
  }

  const merchantName = input.merchant_name ?? await resolveMerchantName(env, input.user_id);
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
  });

  await sendEmail(env, { to: recipients, subject: tpl.subject, html: tpl.html });
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
