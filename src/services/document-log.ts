import type { Env } from "../env";
import { redactSecrets, redactDeep } from "./redact";

/**
 * The narrative of one document, written as it happens.
 *
 * Every incident this integrator has had was silent in the same way: something
 * declined to do the work, recorded that as success, and nobody found out until
 * a merchant counted their own invoices. Counters cannot catch that — they were
 * all reading healthy at zero. What was missing was a place that says, in words,
 * what happened to each sale.
 *
 * Two rules make this useful rather than another log nobody reads:
 *
 *   1. **Successes are recorded too.** A `verified` row — we read the document
 *      back from the destination and it matched what we sent — is what gives the
 *      ABSENCE of a `drift` row any meaning. A failure-only log can never
 *      distinguish "nothing went wrong" from "nothing was checked".
 *
 *   2. **The summary is a sentence, not a code.** It is read months later by
 *      someone with no memory of the day, so it names the sale, the values on
 *      both sides, and what the difference means. `detail_json` carries the
 *      structure; the sentence carries the meaning.
 *
 * This is a log, never state. `processed_orders` remains the answer to "is this
 * order billed"; nothing decides anything by reading these rows.
 */

export type DocumentEventKind =
  /** Payload built and about to be sent. Records the intent we can later verify against. */
  | "built"
  /** The destination refused to create it. Carries the platform's own error text. */
  | "create_failed"
  /** The destination created it. */
  | "created"
  /** Created but deliberately parked as a draft for a human (bad NIF, held rate…). */
  | "held"
  | "finalized"
  | "emailed"
  /** Read back from the destination and everything we care about matched. */
  | "verified"
  /** Read back and something did NOT match. The row this whole table exists for. */
  | "drift"
  /**
   * A history-mode mismatch — a lead, not a verdict. History compares a document
   * against TODAY's configuration, and configuration changes over time (Bikini
   * Books went M01→M05 this year), so the stored code may be the config of its
   * day rather than a fault. Confirmed per document, it is promoted to `drift`;
   * disproven, it is deleted.
   */
  | "drift_lead"
  /** Could not read it back (proxy down, rate limited). NOT evidence of a problem. */
  | "verify_failed"
  | "credit_issued"
  | "reissued"
  /** Deliberately not invoiced: unpaid, zero total, before the cutoff, already done. */
  | "skipped"
  /** Money recorded against an already-certified document (Moloni: a Recibo). */
  | "settled";

const SEVERITY: Record<DocumentEventKind, "info" | "warning" | "error"> = {
  built: "info",
  create_failed: "error",
  created: "info",
  held: "warning",
  finalized: "info",
  emailed: "info",
  verified: "info",
  drift: "error",
  drift_lead: "info",
  verify_failed: "warning",
  credit_issued: "info",
  reissued: "info",
  skipped: "info",
  settled: "info",
};

/** Portuguese labels for the UI. The summary carries the detail; this is the chip. */
export const EVENT_LABELS: Record<DocumentEventKind, string> = {
  built: "Documento preparado",
  create_failed: "Emissão recusada",
  created: "Documento emitido",
  held: "Retido para revisão",
  finalized: "Documento fechado",
  emailed: "Enviado ao comprador",
  verified: "Conferido no destino",
  drift: "Divergência no destino",
  drift_lead: "Divergência por confirmar",
  verify_failed: "Conferência indisponível",
  credit_issued: "Nota de crédito emitida",
  reissued: "Reemitido",
  skipped: "Não facturado",
  settled: "Pagamento registado",
};

/**
 * How long each kind of event is worth keeping.
 *
 * Two tiers, because the value of a row expires at very different rates. A
 * `verified` says "we checked this document three months ago and it matched" —
 * true, and of no use to anyone now. A `drift` is evidence about a fiscal
 * document that may still be open with the AT, and the question it answers can
 * be asked a year later.
 *
 * Declared as an exhaustive Record on purpose: adding a kind to
 * `DocumentEventKind` without classifying it here is a compile error, so the
 * table cannot grow a category nobody decided the lifetime of.
 */
export const RETENTION_TIER: Record<DocumentEventKind, "routine" | "evidence"> = {
  built: "routine",
  created: "routine",
  finalized: "routine",
  emailed: "routine",
  verified: "routine",
  verify_failed: "routine",
  skipped: "routine",
  // A lead is routine on purpose: unconfirmed, it must not enjoy the 365-day
  // evidence window — either it is confirmed into a `drift` or it ages out.
  drift_lead: "routine",
  // Evidence. Something went wrong, or a document was undone — the things you go
  // looking for months later, usually because an accountant asked.
  create_failed: "evidence",
  drift: "evidence",
  held: "evidence",
  credit_issued: "evidence",
  reissued: "evidence",
  settled: "evidence",
};

export const ROUTINE_RETENTION_DAYS = 90;
export const EVIDENCE_RETENTION_DAYS = 365;

/**
 * The purge, as SQL, so it can be run for real in a test rather than asserted
 * about. Same reason `collectedSqlPredicate` exists in lodgify-amounts: two
 * expressions of one rule drift apart, and the way you find out is in production.
 *
 * The date comparison is deliberately `substr(created_at, 1, 10)` against
 * `date(...)` rather than the whole timestamp against `datetime(...)`. The column
 * carries two formats — the schema default writes `2026-08-14 12:00:00` and the
 * code writes ISO `2026-08-14T12:00:00.000Z` — and they sort differently at
 * position 11 (`T` > space). Comparing dates only is indifferent to both.
 */
export function documentEventPurgeSql(tier: "routine" | "evidence"): string {
  const kinds = (Object.keys(RETENTION_TIER) as DocumentEventKind[])
    .filter((k) => RETENTION_TIER[k] === tier)
    .map((k) => `'${k}'`)
    .join(", ");
  const days = tier === "routine" ? ROUTINE_RETENTION_DAYS : EVIDENCE_RETENTION_DAYS;
  return `DELETE FROM document_events
     WHERE event IN (${kinds})
       AND substr(created_at, 1, 10) < date('now', '-${days} day')`;
}

/** The same rule in TypeScript, so a test can hold the SQL to it row for row. */
export function isEventExpired(
  event: DocumentEventKind,
  createdAt: string,
  todayYmd: string,
): boolean {
  const tier = RETENTION_TIER[event];
  if (!tier) return false;
  const days = tier === "routine" ? ROUTINE_RETENTION_DAYS : EVIDENCE_RETENTION_DAYS;
  const cutoff = new Date(`${todayYmd}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  return String(createdAt).slice(0, 10) < cutoff.toISOString().slice(0, 10);
}

export interface DocumentEventInput {
  externalId: string | number;
  event: DocumentEventKind;
  summary: string;
  userId?: string | null;
  shopifyDomain?: string | null;
  sourceKind?: string | null;
  destinationKind?: string | null;
  invoiceId?: string | null;
  detail?: unknown;
  /** 'pipeline' | 'sweep' | 'admin:<name>' | 'cron:<name>' */
  actor?: string | null;
  /** Override the default severity for the kind. */
  severity?: "info" | "warning" | "error";
  /**
   * Natural key for events that must happen at most once, whatever the delivery
   * count. A re-delivered webhook re-runs the work, and without this the sale's
   * timeline reads as though the thing happened three times.
   *
   * Leave unset for events that may legitimately repeat (a `skipped` on each
   * poll pass is a fact about each pass). Convention: `<event>:<invoiceId>` for
   * per-document events, `<event>:<externalId>` for per-sale ones.
   */
  dedupKey?: string | null;
}

const DETAIL_LIMIT = 8000;

/**
 * Writes this log could not make.
 *
 * Module-level, so it survives across requests within an isolate and the daily
 * sweep can read it. Not a metric anyone watches — a number that, if it is ever
 * non-zero, becomes an incident. The whole point of this table is that silent
 * loss stops happening, and a logger that loses rows quietly would be the same
 * bug wearing the uniform of the fix.
 */
let lostWrites = 0;
export function takeLostWriteCount(): number {
  const n = lostWrites;
  lostWrites = 0;
  return n;
}

/**
 * Append one event.
 *
 * Still never throws — a log that can fail an invoice is worse than no log, and
 * both call sites are on the path of a document that already exists. What
 * changed is what happens when the write fails:
 *
 *   - evidence (a drift, a refusal) gets one retry, because losing the record of
 *     a fault is the one loss that matters;
 *   - a loss is COUNTED, and the daily sweep turns a non-zero count into an
 *     incident. Previously it produced a console line in a Worker nobody tails.
 *
 * `dedup_key` makes an event at-most-once: INSERT OR IGNORE against the unique
 * index means a re-delivered webhook re-running the same work adds nothing.
 * Leave it unset for events that may legitimately repeat.
 */
export async function logDocumentEvent(env: Env, input: DocumentEventInput): Promise<void> {
  // Redact before storing: a `create_failed` summary is the destination's own
  // refusal text, and InvoiceXpress puts its credential in the query string of
  // every request, so its errors carry the merchant's key. Same boundary rule
  // as incidents and dev_jobs — redact where text becomes a record.
  const detailRaw = input.detail != null ? JSON.stringify(redactDeep(input.detail)) : null;
  const truncated = detailRaw != null && detailRaw.length > DETAIL_LIMIT;

  const write = () => env.DB.prepare(
    `INSERT OR IGNORE INTO document_events
       (id, external_id, user_id, shopify_domain, source_kind, destination_kind,
        invoice_id, event, severity, summary, detail_json, detail_truncated,
        actor, dedup_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    String(input.externalId),
    input.userId ?? null,
    input.shopifyDomain ?? null,
    input.sourceKind ?? null,
    input.destinationKind ?? null,
    input.invoiceId != null ? String(input.invoiceId) : null,
    input.event,
    input.severity ?? SEVERITY[input.event],
    redactSecrets(input.summary).slice(0, 1000),
    detailRaw != null ? detailRaw.slice(0, DETAIL_LIMIT) : null,
    truncated ? 1 : 0,
    input.actor ?? null,
    input.dedupKey ?? null,
    new Date().toISOString(),
  ).run();

  const isEvidence = RETENTION_TIER[input.event] === "evidence";
  try {
    await write();
  } catch (e: any) {
    if (isEvidence) {
      try {
        await write();
        return;
      } catch { /* fall through to counting it lost */ }
    }
    lostWrites++;
    console.error(`[DocLog] LOST ${input.event} for ${input.externalId}: ${e?.message ?? e}`);
  }
}

export interface DocumentEventRow {
  id: string;
  external_id: string;
  invoice_id: string | null;
  event: DocumentEventKind;
  label: string;
  severity: string;
  summary: string;
  detail: unknown;
  actor: string | null;
  created_at: string;
}

/** One sale's whole story, oldest first — the read this table exists for. */
export async function readDocumentTimeline(
  env: Env,
  externalId: string,
  limit = 200,
): Promise<DocumentEventRow[]> {
  const rows = await env.DB.prepare(
    `SELECT id, external_id, invoice_id, event, severity, summary, detail_json, actor, created_at
       FROM document_events WHERE external_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?`,
  ).bind(String(externalId), limit).all();

  return ((rows.results ?? []) as any[]).map((r) => ({
    id: String(r.id),
    external_id: String(r.external_id),
    invoice_id: r.invoice_id != null ? String(r.invoice_id) : null,
    event: r.event as DocumentEventKind,
    label: EVENT_LABELS[r.event as DocumentEventKind] ?? r.event,
    severity: String(r.severity),
    summary: String(r.summary),
    detail: r.detail_json ? safeParse(r.detail_json) : null,
    actor: r.actor != null ? String(r.actor) : null,
    created_at: String(r.created_at),
  }));
}

/** Recent drifts across a merchant (or the whole fleet when userId is omitted). */
export async function readRecentDrifts(
  env: Env,
  opts: { userId?: string | null; sinceIso?: string; limit?: number } = {},
): Promise<DocumentEventRow[]> {
  const since = opts.sinceIso ?? new Date(Date.now() - 7 * 864e5).toISOString();
  const limit = opts.limit ?? 100;
  const sql = opts.userId
    ? `SELECT id, external_id, invoice_id, event, severity, summary, detail_json, actor, created_at
         FROM document_events WHERE event IN ('drift','drift_lead','create_failed') AND user_id = ? AND created_at >= ?
         ORDER BY created_at DESC LIMIT ?`
    : `SELECT id, external_id, invoice_id, event, severity, summary, detail_json, actor, created_at
         FROM document_events WHERE event IN ('drift','drift_lead','create_failed') AND created_at >= ?
         ORDER BY created_at DESC LIMIT ?`;
  const stmt = opts.userId
    ? env.DB.prepare(sql).bind(opts.userId, since, limit)
    : env.DB.prepare(sql).bind(since, limit);
  const rows = await stmt.all();
  return ((rows.results ?? []) as any[]).map((r) => ({
    id: String(r.id),
    external_id: String(r.external_id),
    invoice_id: r.invoice_id != null ? String(r.invoice_id) : null,
    event: r.event as DocumentEventKind,
    label: EVENT_LABELS[r.event as DocumentEventKind] ?? r.event,
    severity: String(r.severity),
    summary: String(r.summary),
    detail: r.detail_json ? safeParse(r.detail_json) : null,
    actor: r.actor != null ? String(r.actor) : null,
    created_at: String(r.created_at),
  }));
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

/** What the destination actually said, recovered after the fact. */
export interface LastEmissionError {
  message: string;
  http_status?: number;
  source: "document_events" | "logs";
  at: string;
}

/**
 * Recover the destination's own refusal for a sale that has already failed.
 *
 * The dead-letter consumer is handed a message and the fact that it ran out of
 * retries — never the error that caused them, because Cloudflare Queues does not
 * carry it. So the most alarming email the platform sends ("Tentativas esgotadas")
 * was the one that said least: the AI triage received a kind and a connection
 * label and correctly reported that it had nothing to reason with.
 *
 * The reason was on disk the whole time. Both write sites persist it before
 * rethrowing — the document timeline as `create_failed`, and the log row the
 * legacy handler writes — so this reads it back rather than adding another
 * store. The timeline is preferred: it is already the platform's own words,
 * explained.
 */
export async function lookupLastEmissionError(
  env: Env,
  externalId: string,
  opts: { shopifyDomain?: string | null; userId?: string | null } = {},
): Promise<LastEmissionError | null> {
  if (!externalId || externalId === "unknown") return null;

  try {
    const row = await env.DB.prepare(
      `SELECT summary, detail_json, created_at FROM document_events
        WHERE external_id = ? AND event = 'create_failed'
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).bind(String(externalId)).first<{ summary: string; detail_json: string | null; created_at: string }>();

    if (row) {
      const detail = row.detail_json ? safeParse(row.detail_json) as any : null;
      const message = String(detail?.error ?? detail?.message ?? row.summary ?? "").slice(0, 1500);
      if (message) {
        return {
          message,
          http_status: typeof detail?.http_status === "number" ? detail.http_status : undefined,
          source: "document_events",
          at: String(row.created_at),
        };
      }
    }
  } catch (e) {
    console.warn("[document-log] create_failed lookup failed:", e);
  }

  // Fallback: the legacy Shopify→IX handler's own failure log. Scoped by the
  // owning shop/user so one merchant's incident can never quote another's error.
  // `saveLog` JSON-encodes both columns before storing, so the stored text is a
  // quoted JSON string — hence the unanchored LIKE and the parse on the way out.
  try {
    const scope = opts.shopifyDomain ?? opts.userId;
    if (!scope) return null;
    const row = await env.DB.prepare(
      `SELECT response, created_at FROM logs
        WHERE ${opts.shopifyDomain ? "shopify_domain = ?" : "user_id = ?"}
          AND status >= 400
          AND response LIKE '%IX create failed%'
          AND payload LIKE ?
        ORDER BY created_at DESC LIMIT 1`,
    ).bind(scope, `%${externalId}%`).first<{ response: string; created_at: string }>();

    if (row?.response) {
      const parsed = safeParse(String(row.response));
      const message = (typeof parsed === "string" ? parsed : String(row.response)).slice(0, 1500);
      return { message, source: "logs", at: String(row.created_at) };
    }
  } catch (e) {
    console.warn("[document-log] logs fallback lookup failed:", e);
  }

  return null;
}

/**
 * Turn a platform's raw refusal into a sentence that says what it means.
 *
 * The destinations answer in their own vocabulary, and the same words have been
 * misread more than once: InvoiceXpress replies "Fiscal is invalid" when the
 * COUNTRY is wrong far more often than when the NIF is, and a failed read can
 * arrive as HTTP 200 with success:false. Known signatures get a sentence; the
 * rest are passed through verbatim rather than guessed at, because a wrong
 * explanation is worse than a raw error.
 */
export function explainPlatformError(raw: string, destination?: string | null): string {
  const t = String(raw ?? "").slice(0, 600);
  const low = t.toLowerCase();

  if (/fiscal is invalid|fiscal_id/.test(low)) {
    return `${t} — no InvoiceXpress esta mensagem aponta para o PAÍS do cliente com muito mais frequência do que para o NIF: o campo espera o nome completo do país, não o código ISO (PT é rejeitado, "Portugal" é aceite).`;
  }
  if (/doc010|cliente.*(inv[aá]lid|n[aã]o é v[aá]lid)/.test(low)) {
    return `${t} — normalmente é o registo de cliente no destino que está partido, não o payload enviado. Costuma resolver-se recriando o cliente em vez de mexer na factura.`;
  }
  if (/raz[aã]o de isen[çc][aã]o/.test(low)) {
    return `${t} — o destino recusa uma linha a 0% sem um código de isenção associado. Confirmar a razão de isenção configurada para a loja.`;
  }
  if (/mismatch|drift/.test(low)) {
    return `${t} — o guarda de total impediu a emissão porque o documento não igualava o valor pago. É o comportamento correcto: corrige-se a causa do cálculo, nunca o total.`;
  }
  if (/429|rate limit|too many requests/.test(low)) {
    return `${t} — limite de pedidos do destino. Não é um erro do documento; volta a tentar-se sozinho.`;
  }
  if (/401|403|unauthor|forbidden|invalid api key/.test(low)) {
    return `${t} — credenciais recusadas pelo destino. A factura não tem culpa; é preciso renovar a ligação.`;
  }
  return t;
}
