import type { Env } from "../env";

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
  /** Could not read it back (proxy down, rate limited). NOT evidence of a problem. */
  | "verify_failed"
  | "credit_issued"
  | "reissued"
  /** Deliberately not invoiced: unpaid, zero total, before the cutoff, already done. */
  | "skipped";

const SEVERITY: Record<DocumentEventKind, "info" | "warning" | "error"> = {
  built: "info",
  create_failed: "error",
  created: "info",
  held: "warning",
  finalized: "info",
  emailed: "info",
  verified: "info",
  drift: "error",
  verify_failed: "warning",
  credit_issued: "info",
  reissued: "info",
  skipped: "info",
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
  verify_failed: "Conferência indisponível",
  credit_issued: "Nota de crédito emitida",
  reissued: "Reemitido",
  skipped: "Não facturado",
};

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
}

/**
 * Append one event. Best-effort by construction: a log that can fail an invoice
 * is worse than no log, so every error here is swallowed after a console line.
 */
export async function logDocumentEvent(env: Env, input: DocumentEventInput): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO document_events
         (id, external_id, user_id, shopify_domain, source_kind, destination_kind,
          invoice_id, event, severity, summary, detail_json, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.summary.slice(0, 1000),
      input.detail != null ? JSON.stringify(input.detail).slice(0, 8000) : null,
      input.actor ?? null,
      new Date().toISOString(),
    ).run();
  } catch (e: any) {
    console.error(`[DocLog] could not record ${input.event} for ${input.externalId}: ${e?.message ?? e}`);
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
         FROM document_events WHERE event IN ('drift','create_failed') AND user_id = ? AND created_at >= ?
         ORDER BY created_at DESC LIMIT ?`
    : `SELECT id, external_id, invoice_id, event, severity, summary, detail_json, actor, created_at
         FROM document_events WHERE event IN ('drift','create_failed') AND created_at >= ?
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
