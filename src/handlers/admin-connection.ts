import type { Env } from "../env";
import { AppStorage } from "../storage";
import type { AdapterCtx, FinalizeDateStrategy } from "../adapters/types";
import { getSourceAdapter, getDestinationAdapter } from "../adapters/registry";
import { getSourceRecovery, hasSourceRecovery } from "../adapters/recovery/registry";
import type { SourceRecordRef } from "../adapters/recovery/types";
import type { ConnectionContext } from "../services/connection-context";
import { listUserConnections } from "../services/connection-context";
import { buildAdapterCtx } from "../services/adapter-ctx";
import { cancelReference, cancelReferenceCandidates } from "../services/document-references";
import { runAdapterPipeline } from "./generic-pipeline";
import { takeBackLodgifyDocuments, type TakeBackMode } from "./lodgify-billing";
import { sendDevModeEmail } from "./notify";
import { formatPtDate } from "../ix/date";

/**
 * The recovery toolbox, once, for any (source × destination) connection.
 *
 * The Shopify→InvoiceXpress version of these five operations lives in admin.ts
 * and the Stripe one in admin-stripe.ts; both are ~700 lines that differ mainly
 * in which API they call to answer "what was sold" and "what did we issue". This
 * asks the SourceRecovery for the first and the DestinationAdapter for the
 * second, so adding Lodgify is a recovery class rather than a third copy.
 */

export interface RecoveryOptions {
  dry_run?: boolean;
  limit?: number;
  reason?: string | null;
  triggered_by?: string | null;
  notify_emails?: string[];
}

export interface RecoveryResultRow {
  external_id: string;
  label?: string;
  invoice_id?: string;
  status: "created" | "finalized" | "skipped" | "error" | "dry_run" | "deleted" | "credited";
  message: string;
  original_date?: string;
  target_date?: string;
}

/** One dev_jobs row per operation, stamped with the connection it acted on. */
async function startJob(
  storage: AppStorage,
  ctx: ConnectionContext,
  type: string,
  params: any,
  options: RecoveryOptions,
): Promise<string> {
  const jobId = crypto.randomUUID();
  await storage.startDevJob({
    id: jobId,
    type,
    params,
    triggered_by: options.triggered_by ?? null,
    reason: options.reason ?? null,
    source_kind: ctx.source,
    destination_kind: ctx.destination,
  });
  return jobId;
}

function storageFor(env: Env, ctx: ConnectionContext): AppStorage {
  return new AppStorage(env, ctx.config.shopify_domain ?? undefined, ctx.userId);
}

async function notify(options: RecoveryOptions, subject: string, body: string): Promise<void> {
  if (!options.notify_emails || options.notify_emails.length === 0) return;
  await sendDevModeEmail({ recipients: options.notify_emails, subject, body });
}

async function ctxFor(env: Env, conn: ConnectionContext): Promise<AdapterCtx> {
  const { ctx } = await buildAdapterCtx(env, {
    config: conn.config,
    source: conn.source,
    destination: conn.destination,
    sourceConfig: conn.sourceConfig,
    destinationConfig: conn.destinationConfig,
  });
  return ctx;
}

function summarize(results: RecoveryResultRow[]) {
  const count = (s: RecoveryResultRow["status"]) => results.filter((r) => r.status === s).length;
  return {
    total: results.length,
    success: count("created") + count("finalized") + count("deleted") + count("credited"),
    finalized: count("finalized"),
    skipped: count("skipped"),
    errors: count("error"),
    would_create: count("dry_run"),
    would_finalize: count("dry_run"),
  };
}

function jobStatus(s: ReturnType<typeof summarize>): "success" | "partial" | "error" {
  if (s.errors === 0) return "success";
  return s.success > 0 || s.would_create > 0 ? "partial" : "error";
}

// ── Capabilities ─────────────────────────────────────────────────────────────

/**
 * What the dev-mode panel needs to decide which cards to render, BEFORE it
 * issues any request. Built here rather than in the backoffice so the capability
 * matrix has exactly one home — the adapters that implement it.
 */
export async function connectionCapabilities(env: Env, userId: string) {
  const connections = await listUserConnections(env, userId);

  return {
    connections: connections.map((c) => {
      const dest = getDestinationAdapter(c.destination);
      const src = getSourceAdapter(c.source);
      const recoverable = hasSourceRecovery(c.source);

      return {
        source: c.source,
        destination: c.destination,
        label: c.label,
        external_id: externalIdDescriptor(c.source),
        // What the backfill will refuse to bill behind, so the panel can show it
        // before a run rather than after 23 skipped rows.
        invoice_cutoff: c.invoiceCutoff ?? null,
        capabilities: {
          // Every write needs the source to be readable at all.
          backfill: recoverable && src.capabilities.listCandidates,
          reemit: recoverable && src.capabilities.resolveById,
          forceReemit: recoverable && src.capabilities.resolveById && !!dest.deleteDraft,
          deleteDraft: recoverable && !!dest.deleteDraft && dest.capabilities.drafts,
          creditNote: recoverable && !!dest.creditFullDocument,
          finalizeDrafts: dest.capabilities.drafts && !!dest.finalizeWithDate,
          orderNumberFilter: src.capabilities.orderNumberFilter,
          paidTotals: src.capabilities.paidTotals,
        },
      };
    }),
  };
}

/**
 * Move (or clear) the date this connection starts invoicing from.
 *
 * The cutoff is stamped from the Stripe subscription's start when a paused
 * connection is activated, which is right for a merchant onboarding today and
 * wrong for one whose Rioko subscription was created after the sales it is
 * meant to bill: their whole back-catalogue lands behind the cutoff and every
 * backfill answers "Anterior ao início da facturação" for all of it. This is the
 * deliberate, per-connection correction — as opposed to `ignore_cutoff`, which
 * exempts ONE bounded run without changing what the unattended paths will do.
 *
 * `null` clears it: back to the connection's `created_at` as the floor.
 */
export async function setConnectionInvoiceCutoff(
  env: Env,
  conn: ConnectionContext,
  value: string | null,
  options: { triggered_by?: string | null } = {},
): Promise<{ source: string; destination: string; invoice_cutoff: string | null }> {
  if (!conn.userId) throw new Error("A ligação não tem user_id — não sei que ligação actualizar.");

  // A bare day is what the panel sends; store it as the instant it begins, since
  // every reader compares it against an ISO timestamp with Date.parse.
  let stored: string | null = null;
  if (value != null && String(value).trim() !== "") {
    const raw = String(value).trim();
    const ymd = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw;
    if (Number.isNaN(Date.parse(ymd))) throw new Error(`Data inválida: ${raw}`);
    stored = new Date(ymd).toISOString();
  }

  await env.DB.prepare(
    `UPDATE connections SET invoice_cutoff = ?, updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ? AND source_kind = ? AND destination_kind = ? AND status = 'active'`
  ).bind(stored, conn.userId, conn.source, conn.destination).run();

  console.log(`[Rioko] invoice_cutoff ${conn.connectionLabel} (${conn.userId}) → ${stored ?? "null"}`
    + ` by ${options.triggered_by ?? "unknown"}`);
  return { source: conn.source, destination: conn.destination, invoice_cutoff: stored };
}

/** How to label and validate the id field for this source in the panel. */
function externalIdDescriptor(source: string) {
  switch (source) {
    case "shopify": return { kind: "order_number", label: "Nº da encomenda", placeholder: "1234" };
    case "stripe": return { kind: "stripe_id", label: "ID Stripe", placeholder: "pi_3Tp…" };
    case "lodgify": return { kind: "booking_id", label: "ID da reserva", placeholder: "4429" };
    default: return { kind: "external_id", label: "ID externo", placeholder: "" };
  }
}

// ── Backfill ─────────────────────────────────────────────────────────────────

export interface BackfillOptions extends RecoveryOptions {
  from: string;
  to: string;
  /**
   * Bill sales from BEFORE the connection's `invoice_cutoff` as well.
   *
   * The cutoff exists so a new merchant's back-catalogue is never billed by an
   * automatic path, and that must stay true — this flag is how a human asks for
   * that history deliberately, on a bounded, dry-runnable, one-shot command,
   * instead of by moving the cutoff (which would hand the same history to the
   * next unattended poll, minutes later, with no limit and nobody watching).
   */
  ignore_cutoff?: boolean;
}

/**
 * Invoice everything billable in a window that is not already resolved.
 *
 * "Resolved" is deliberately broader than "invoiced": a payment an operator
 * hand-matched or marked "não necessária" must stay untouched, or every run
 * resurrects the exclusions they made. See AppStorage.getResolvedOrderIds.
 */
export async function backfillConnection(env: Env, conn: ConnectionContext, options: BackfillOptions) {
  const storage = storageFor(env, conn);
  // Lodgify defaults to a dry run when the caller says nothing, matching
  // /admin/lodgify/unbill-premature. This issues fiscal documents in bulk to a
  // merchant whose original complaint was being invoiced too early, and the
  // asymmetry between "I forgot the flag" and "I billed 12 future stays" is not
  // close.
  const dryRun = options.dry_run ?? (conn.source === "lodgify");
  const limit = Math.min(options.limit ?? 100, 500);
  const jobId = await startJob(storage, conn, dryRun ? "connection_backfill_dry_run" : "connection_backfill", {
    from: options.from, to: options.to, limit, dry_run: dryRun,
  }, options);

  const results: RecoveryResultRow[] = [];
  try {
    const recovery = getSourceRecovery(conn.source);
    const candidates = await recovery.listCandidates(conn, env, { from: options.from, to: options.to, limit });

    const resolved = await storage.getResolvedOrderIds(candidates.map((c) => c.externalId), conn.scope);
    const cutoff = options.ignore_cutoff ? null : (conn.invoiceCutoff ? Date.parse(conn.invoiceCutoff) : null);

    for (const record of candidates) {
      const row = await billOneRecord(env, conn, storage, record, { dryRun, resolved, cutoff });
      results.push(row);
    }
  } catch (e: any) {
    const error = String(e?.message ?? e);
    await storage.finishDevJob(jobId, "error", { error }, results);
    return { job_id: jobId, ...summarize(results), dry_run: dryRun, from: options.from, to: options.to, results, error };
  }

  const summary = { ...summarize(results), dry_run: dryRun, from: options.from, to: options.to };
  await storage.finishDevJob(jobId, jobStatus(summary), summary, results);
  await notify(options,
    `Rioko Dev Mode — backfill ${conn.connectionLabel}${dryRun ? " (dry-run)" : ""}`,
    `Total: ${summary.total}\nEmitidas: ${summary.success}\nIgnoradas: ${summary.skipped}\nErros: ${summary.errors}`
    + `${dryRun ? `\nA emitir: ${summary.would_create}` : ""}\nJob ID: ${jobId}`);

  return { job_id: jobId, ...summary, results };
}

/**
 * Should this record be invoiced?
 *
 * Pure, and separated from the act of invoicing, because these four rules are
 * the whole safety of a bulk run: get one wrong and a backfill either
 * double-invoices a merchant or silently bills sales that were never ours.
 */
export function classifyRecordForBilling(
  record: SourceRecordRef,
  o: { dryRun: boolean; resolved: Set<string>; cutoff: number | null },
): { action: "skip"; message: string } | { action: "dry_run"; message: string } | { action: "bill" } {
  // The source itself says this is not a completed sale.
  if (record.blocker) return { action: "skip", message: record.blocker };

  // Already invoiced, hand-matched by an operator, marked "não necessária", or
  // billed as Lodgify instalments. Re-billing any of those is the bug.
  if (o.resolved.has(record.externalId)) {
    return { action: "skip", message: "Já facturada ou resolvida manualmente" };
  }

  // Sales from before Rioko took the connection over were never ours to issue —
  // the merchant's previous process owned them.
  if (o.cutoff && record.paidAt && Date.parse(record.paidAt) < o.cutoff) {
    return { action: "skip", message: "Anterior ao início da facturação (invoice_cutoff)" };
  }

  if (o.dryRun) {
    return { action: "dry_run", message: `Seria facturada (${record.paidTotal?.toFixed(2) ?? "?"} €)` };
  }
  return { action: "bill" };
}

/** The per-record decision every bulk path shares, plus the act of billing. */
async function billOneRecord(
  env: Env,
  conn: ConnectionContext,
  storage: AppStorage,
  record: SourceRecordRef,
  o: { dryRun: boolean; resolved: Set<string>; cutoff: number | null },
): Promise<RecoveryResultRow> {
  const base = { external_id: record.externalId, label: record.label };

  const decision = classifyRecordForBilling(record, o);
  if (decision.action === "skip") return { ...base, status: "skipped", message: decision.message };
  if (decision.action === "dry_run") return { ...base, status: "dry_run", message: decision.message };

  try {
    await runAdapterPipeline({
      env, config: conn.config, source: conn.source, destination: conn.destination,
      topic: "created", webhookId: null, body: record.replayBody,
      sourceConfig: conn.sourceConfig, destinationConfig: conn.destinationConfig,
    });
    const issued = await storage.getInvoiceByOrderId(record.externalId);
    return {
      ...base,
      invoice_id: issued?.invoice_id,
      status: "created",
      message: issued?.invoice_id ? `Documento ${issued.invoice_id}` : "Processada",
    };
  } catch (e: any) {
    return { ...base, status: "error", message: String(e?.message ?? e) };
  }
}

// ── Re-emit ──────────────────────────────────────────────────────────────────

export async function reemitConnection(
  env: Env,
  conn: ConnectionContext,
  input: string,
  options: RecoveryOptions & { force?: boolean },
) {
  const storage = storageFor(env, conn);
  const jobId = await startJob(storage, conn, "connection_reemit", { external_id: input, force: !!options.force }, options);

  const fail = async (error: string) => {
    await storage.finishDevJob(jobId, "error", { error }, []);
    return { job_id: jobId, status: "error" as const, error };
  };

  let record: SourceRecordRef | null;
  try {
    record = await getSourceRecovery(conn.source).resolveRecord(input, conn, env);
  } catch (e: any) {
    return fail(String(e?.message ?? e));
  }
  if (!record) return fail(`${input} não encontrada em ${conn.source}`);
  if (record.blocker && !options.force) {
    return fail(`${record.label}: ${record.blocker}. Use "forçar" se souber o que está a fazer.`);
  }

  // Replacing a document means removing the one being replaced. Only ever a
  // DRAFT: a certified document is a fiscal record, corrected with a credit
  // note, so it is left standing and the operator is told so out loud.
  let previousDocument: "discarded" | "kept_finalized" | "none" | "unknown" = "none";
  let previousDocumentId: string | null = null;
  if (options.force) {
    const previous = await storage.getInvoiceByOrderId(record.externalId);
    if (previous?.invoice_id) {
      previousDocumentId = String(previous.invoice_id);
      const dest = getDestinationAdapter(conn.destination);
      if (dest.deleteDraft) {
        try {
          const outcome = await dest.deleteDraft(previousDocumentId, await ctxFor(env, conn));
          previousDocument = outcome === "finalized" ? "kept_finalized" : "discarded";
        } catch (e: any) {
          console.warn(`[Rioko] could not discard previous document ${previousDocumentId}: ${e?.message ?? e}`);
          previousDocument = "unknown";
        }
      } else {
        previousDocument = "unknown";
      }
    }
    await storage.deleteProcessedInvoice(record.externalId, conn.source);
  }

  try {
    await runAdapterPipeline({
      env, config: conn.config, source: conn.source, destination: conn.destination,
      topic: "created", webhookId: null, body: record.replayBody,
      sourceConfig: conn.sourceConfig, destinationConfig: conn.destinationConfig,
      skipReferenceCheck: !!options.force,
    });
  } catch (e: any) {
    return fail(`Pipeline failed: ${e?.message ?? e}`);
  }

  const warning =
    previousDocument === "kept_finalized"
      ? `ATENÇÃO: ${previousDocumentId} já estava finalizado e foi mantido — emita nota de crédito se for duplicado`
      : previousDocument === "unknown" && previousDocumentId
        ? `ATENÇÃO: não foi possível confirmar o estado do documento anterior ${previousDocumentId} — verifique antes de dar por concluído`
        : null;

  const issued = await storage.getInvoiceByOrderId(record.externalId);
  const summary = {
    external_id: record.externalId,
    label: record.label,
    invoice_id: issued?.invoice_id ?? null,
    force: !!options.force,
    previous_document: previousDocument,
    previous_document_id: previousDocumentId,
    ...(warning ? { warning } : {}),
  };
  await storage.finishDevJob(jobId, "success", summary, [summary]);
  await notify(options,
    `Rioko Dev Mode — re-emitir ${record.label} (${conn.connectionLabel})`,
    `Registo: ${record.label}\nExternal id: ${record.externalId}\nDocumento: ${issued?.invoice_id ?? "—"}`
    + `\nForçado: ${options.force ? "sim" : "não"}\nMotivo: ${options.reason ?? "—"}\nJob ID: ${jobId}`
    + `${warning ? `\n\n${warning}` : ""}`);

  return { job_id: jobId, status: "success" as const, ...summary };
}

// ── Delete draft ─────────────────────────────────────────────────────────────

export async function deleteConnectionDraft(env: Env, conn: ConnectionContext, input: string, options: RecoveryOptions) {
  const storage = storageFor(env, conn);
  const jobId = await startJob(storage, conn, "connection_delete_draft", { external_id: input }, options);

  const fail = async (error: string) => {
    await storage.finishDevJob(jobId, "error", { error }, []);
    return { job_id: jobId, status: "error" as const, error };
  };

  const dest = getDestinationAdapter(conn.destination);
  if (!dest.deleteDraft) return fail(`${conn.destination} não suporta apagar rascunhos — emita uma nota de crédito.`);

  // A Lodgify booking can be several documents (one per instalment), and they
  // have to be taken back together: deleting the first and leaving the second
  // standing is the exact failure the shared take-back exists to prevent.
  if (conn.source === "lodgify") {
    return takeBackLodgifyForAdmin(env, conn, storage, jobId, input, options, "delete_drafts");
  }

  const lookup = await resolveDocument(env, conn, storage, input);
  if ("error" in lookup) return fail(lookup.error);

  let outcome: "deleted" | "already_gone" | "finalized";
  try {
    outcome = await dest.deleteDraft(lookup.invoiceId, await ctxFor(env, conn));
  } catch (e: any) {
    // An unreadable document is not a deleted one: clearing our record here is
    // how the next backfill mints a duplicate against a live document.
    return fail(`Não consegui apagar o documento ${lookup.invoiceId}: ${e?.message ?? e}`);
  }

  if (outcome === "finalized") {
    return fail(`O documento ${lookup.invoiceId} está certificado — emita uma nota de crédito em vez de o apagar.`);
  }

  await storage.deleteProcessedInvoice(lookup.externalId, conn.source);
  const summary = {
    external_id: lookup.externalId,
    invoice_id: lookup.invoiceId,
    destination: conn.destination,
    ...(outcome === "already_gone" ? { message: "Documento já não existia no destino — removida a ligação obsoleta." } : {}),
  };
  await storage.finishDevJob(jobId, "success", summary, [summary]);
  await notify(options,
    `Rioko Dev Mode — rascunho apagado (${conn.connectionLabel})`,
    `Documento ${lookup.invoiceId} apagado.\nRegisto: ${lookup.externalId}\nMotivo: ${options.reason ?? "—"}\nJob ID: ${jobId}`);

  return { job_id: jobId, status: "success" as const, ...summary };
}

// ── Credit note ──────────────────────────────────────────────────────────────

export async function creditConnectionDocument(env: Env, conn: ConnectionContext, input: string, options: RecoveryOptions) {
  const storage = storageFor(env, conn);
  const jobId = await startJob(storage, conn, "connection_issue_credit_note", { external_id: input }, options);

  const fail = async (error: string) => {
    await storage.finishDevJob(jobId, "error", { error }, []);
    return { job_id: jobId, status: "error" as const, error };
  };

  const dest = getDestinationAdapter(conn.destination);
  if (!dest.creditFullDocument) {
    return fail(`${conn.destination} ainda não sabe emitir nota de crédito sobre um documento existente.`);
  }

  // Same reason as delete-draft: a part-paid booking is several documents, and
  // crediting one of them leaves the sale half-undone.
  if (conn.source === "lodgify") {
    return takeBackLodgifyForAdmin(env, conn, storage, jobId, input, options, "delete_or_credit");
  }

  const lookup = await resolveDocument(env, conn, storage, input);
  if ("error" in lookup) return fail(lookup.error);

  // Shopify keys the cancel reference on the ORDER NUMBER — that exact spelling
  // is what reconciliation matches on, so it must not drift. Every other source
  // keys on the external id.
  const key = conn.source === "shopify" && lookup.orderNumber != null ? lookup.orderNumber : lookup.externalId;

  let result;
  try {
    result = await dest.creditFullDocument(lookup.invoiceId, await ctxFor(env, conn), {
      reference: cancelReference(conn.source, key),
      matchReferences: cancelReferenceCandidates(conn.source, key),
      reason: options.reason ?? null,
      dryRun: !!options.dry_run,
    });
  } catch (e: any) {
    return fail(String(e?.message ?? e));
  }

  const summary = {
    external_id: lookup.externalId,
    invoice_id: lookup.invoiceId,
    credit_note_id: result.creditId,
    destination: conn.destination,
    dry_run: !!options.dry_run,
    ...(result.alreadyExisted ? { message: "Nota de crédito já existia, nada emitido" } : {}),
    ...(result.preview ? { preview: result.preview } : {}),
  };
  await storage.finishDevJob(jobId, "success", summary, [summary]);
  await notify(options,
    `Rioko Dev Mode — nota de crédito (${conn.connectionLabel})`,
    `Nota de crédito ${result.creditId} para o documento ${lookup.invoiceId}.\nRegisto: ${lookup.externalId}`
    + `\nMotivo: ${options.reason ?? "—"}\nJob ID: ${jobId}`);

  return { job_id: jobId, status: "success" as const, ...summary };
}

/**
 * Delete-draft and credit-note for Lodgify, which are the same operation over
 * the booking's whole document set and differ only in what they do with a
 * document that is already certified.
 */
async function takeBackLodgifyForAdmin(
  env: Env,
  conn: ConnectionContext,
  storage: AppStorage,
  jobId: string,
  input: string,
  options: RecoveryOptions,
  mode: TakeBackMode,
) {
  const bookingId = input.trim().replace(/^LOD-/i, "");
  const fail = async (error: string) => {
    await storage.finishDevJob(jobId, "error", { error }, []);
    return { job_id: jobId, status: "error" as const, error };
  };

  let result;
  try {
    result = await takeBackLodgifyDocuments(env, {
      userId: conn.userId!,
      bookingId,
      destination: conn.destination,
      config: conn.config,
      sourceCfg: conn.sourceConfig,
      destinationConfig: conn.destinationConfig,
      dryRun: !!options.dry_run,
      mode,
      reason: options.reason ?? null,
      // An operator undoing a booking means it is unbilled and may be billed
      // again — unlike the cancellation path, where it must stay un-billable.
      forgetStandardRecord: true,
    });
  } catch (e: any) {
    return fail(String(e?.message ?? e));
  }

  if (result.invoiceIds.length === 0) return fail(`Não há documentos registados para a reserva ${bookingId}`);

  const summary = {
    external_id: bookingId,
    destination: conn.destination,
    mode,
    dry_run: !!options.dry_run,
    documents: result.invoiceIds,
    deleted: result.deleted,
    credited: result.credited,
    // Left standing: either certified with mode=delete_drafts, or unreadable.
    // Either way a human has to look, so it is never reported as done.
    kept: result.finalized,
    ...(result.finalized.length > 0
      ? { warning: `ATENÇÃO: ${result.finalized.length} documento(s) não foram anulados (${result.finalized.join(", ")}) — os registos da reserva foram mantidos para não a facturar outra vez` }
      : {}),
  };
  const status = result.finalized.length === 0 ? "success" : "partial";
  await storage.finishDevJob(jobId, status, summary, [summary]);
  await notify(options,
    `Rioko Dev Mode — reserva ${bookingId} anulada (${conn.connectionLabel})`,
    `Documentos: ${result.invoiceIds.join(", ")}\nApagados: ${result.deleted.length}\nCreditados: ${result.credited.length}`
    + `\nMantidos: ${result.finalized.length}\nMotivo: ${options.reason ?? "—"}\nJob ID: ${jobId}`);

  return { job_id: jobId, status: "success" as const, ...summary };
}

/**
 * From whatever the operator typed to the document we issued for it.
 *
 * Goes through the source so "#1137" resolves the same way it does everywhere
 * else, and so the order number is available for the reference convention.
 */
async function resolveDocument(
  env: Env,
  conn: ConnectionContext,
  storage: AppStorage,
  input: string,
): Promise<{ error: string } | { externalId: string; invoiceId: string; orderNumber: number | null }> {
  let record: SourceRecordRef | null;
  try {
    record = await getSourceRecovery(conn.source).resolveRecord(input, conn, env);
  } catch (e: any) {
    return { error: String(e?.message ?? e) };
  }
  if (!record) return { error: `${input} não encontrada em ${conn.source}` };

  const issued = await storage.getInvoiceByOrderId(record.externalId);
  if (!issued?.invoice_id) return { error: `Não há documento registado para ${record.label}` };
  return { externalId: record.externalId, invoiceId: String(issued.invoice_id), orderNumber: record.orderNumber };
}

// ── Finalize drafts ──────────────────────────────────────────────────────────

export interface FinalizeDraftsOptions extends RecoveryOptions {
  date_strategy?: FinalizeDateStrategy;
  from_date?: string | null;
  to_date?: string | null;
  from_order_number?: number | null;
  to_order_number?: number | null;
}

/**
 * Oldest transaction first.
 *
 * Both destinations refuse a document dated behind the last one already CLOSED
 * in its series, so certifying the newest draft first raises the floor over
 * every older draft in the same run: a 22-document Moloni batch closed one
 * invoice dated 12/08 and then failed the other 21 with `date >= 2026-08-12`.
 *
 * The rows arrive in insertion order (`rowid`), and a backfill inserts them in
 * whatever order the source listed the sales — for Stripe, newest first. So
 * insertion order is not transaction order, and the card's own promise ("mais
 * antigo→mais recente") was not being kept.
 *
 * A row whose date we do not know sorts LAST rather than first: it must not set
 * the series floor for rows whose date we do know. Ties keep their existing
 * order (Array.prototype.sort is stable).
 */
export function orderByTransactionDate<T extends { id: string; created_at: string | null }>(
  rows: T[],
  paidAtOf: (id: string) => string | null,
): T[] {
  const key = (r: T) => (paidAtOf(r.id) ?? r.created_at ?? "").slice(0, 10);
  return [...rows].sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (!ka || !kb) return ka === kb ? 0 : (ka ? -1 : 1);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

export async function finalizeConnectionDrafts(env: Env, conn: ConnectionContext, options: FinalizeDraftsOptions) {
  const storage = storageFor(env, conn);
  const dryRun = !!options.dry_run;
  const strategy: FinalizeDateStrategy = options.date_strategy ?? "closest_available";
  // Capped well below Cloudflare's 1000-subrequest ceiling: each row costs a
  // GET, sometimes a PUT, and a changeState.
  const limit = Math.min(options.limit ?? 100, 100);

  const jobId = await startJob(storage, conn, dryRun ? "connection_finalize_drafts_dry_run" : "connection_finalize_drafts", {
    limit, dry_run: dryRun, date_strategy: strategy,
    from_date: options.from_date ?? null, to_date: options.to_date ?? null,
    from_order_number: options.from_order_number ?? null, to_order_number: options.to_order_number ?? null,
  }, options);

  const results: RecoveryResultRow[] = [];
  const dest = getDestinationAdapter(conn.destination);
  if (!dest.finalizeWithDate) {
    const error = `${conn.destination} não tem rascunhos com data a negociar — nada para finalizar.`;
    await storage.finishDevJob(jobId, "error", { error }, []);
    return { job_id: jobId, ...summarize(results), dry_run: dryRun, date_strategy: strategy, results, error };
  }

  if (!conn.userId) {
    const error = "A ligação não tem user_id — não consigo listar os rascunhos deste cliente.";
    await storage.finishDevJob(jobId, "error", { error }, []);
    return { job_id: jobId, ...summarize(results), dry_run: dryRun, date_strategy: strategy, results, error };
  }

  let processed = await storage.listProcessedInvoicesByUser(conn.userId, conn.source, limit, "asc");
  if (options.from_date || options.to_date) {
    processed = processed.filter((r) => {
      const created = r.created_at ?? "";
      if (options.from_date && created < options.from_date) return false;
      if (options.to_date && created > options.to_date) return false;
      return true;
    });
  }

  // Paid totals (and order numbers, where the source has them) for the rows we
  // are about to certify. A failed lookup leaves the map empty, and each row is
  // then judged on the rest — never certified on the strength of an absence.
  const recovery = hasSourceRecovery(conn.source) ? getSourceRecovery(conn.source) : null;
  let described = new Map<string, { orderNumber: number | null; paidTotal: number | null; paidAt: string | null }>();
  if (recovery?.describe && processed.length > 0) {
    try {
      described = await recovery.describe(processed.map((r) => r.id), conn, env);
    } catch (e) {
      console.error("[Rioko] finalize paid-total lookup failed:", e);
    }
  }

  if (options.from_order_number != null || options.to_order_number != null) {
    processed = processed.filter((r) => {
      const n = described.get(r.id)?.orderNumber;
      if (n == null) return false;
      if (options.from_order_number != null && n < options.from_order_number) return false;
      if (options.to_order_number != null && n > options.to_order_number) return false;
      return true;
    });
  }

  processed = orderByTransactionDate(processed, (id) => described.get(id)?.paidAt ?? null);

  const ctx = await ctxFor(env, conn);
  const batch = dest.prepareFinalizeBatch ? await dest.prepareFinalizeBatch(ctx, { strategy }) : undefined;

  for (const row of processed) {
    try {
      const outcome = await dest.finalizeWithDate(row.invoice_id, ctx, {
        strategy,
        batch,
        dryRun,
        paidTotal: described.get(row.id)?.paidTotal ?? null,
        dateMovedNote: (originalDate) => transactionNote(conn.source, row.id, described.get(row.id)?.orderNumber, originalDate),
      });
      results.push({
        external_id: row.id,
        invoice_id: row.invoice_id,
        status: outcome.status,
        message: outcome.message,
        ...("originalDate" in outcome ? { original_date: outcome.originalDate, target_date: outcome.date } : {}),
      });
    } catch (e) {
      results.push({ external_id: row.id, invoice_id: row.invoice_id, status: "error", message: String(e) });
    }
  }

  const summary = { ...summarize(results), dry_run: dryRun, date_strategy: strategy };
  await storage.finishDevJob(jobId, jobStatus(summary), summary, results);
  await notify(options,
    `Rioko Dev Mode — finalizar rascunhos ${conn.connectionLabel}${dryRun ? " (dry-run)" : ""}`,
    `Total: ${summary.total}\nEstratégia: ${strategy}\nFinalizadas: ${summary.finalized}\nIgnoradas: ${summary.skipped}`
    + `\nErros: ${summary.errors}${dryRun ? `\nA finalizar: ${summary.would_finalize}` : ""}\nJob ID: ${jobId}`);

  return { job_id: jobId, ...summary, results };
}

/**
 * What to write into a document's observations when its date had to move.
 *
 * Worded per source because only the source knows what to call the transaction,
 * and Portuguese contracts the article differently for each ("à encomenda", "ao
 * pagamento").
 */
function transactionNote(source: string, externalId: string, orderNumber: number | null | undefined, originalDate: string): string | null {
  const when = formatPtDate(originalDate);
  switch (source) {
    case "shopify":
      return orderNumber != null ? `Fatura referente à encomenda #${orderNumber} de ${when}` : null;
    case "stripe":
      return `Fatura referente ao pagamento Stripe ${externalId} de ${when}`;
    case "lodgify":
      return `Fatura referente à reserva LOD-${externalId} de ${when}`;
    default:
      return null;
  }
}
