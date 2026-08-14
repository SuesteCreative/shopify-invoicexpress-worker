import type { Env } from "../env";
import type { IRequestConfig } from "../storage";
import { AppStorage } from "../storage";
import type { DestinationKind } from "../storage";
import type { AdapterCtx, DestinationAdapter, FinalizeDateStrategy } from "../adapters/types";
import { getDestinationAdapter } from "../adapters/registry";
import { runAdapterPipeline } from "./generic-pipeline";
import { sendDevModeEmail } from "./notify";
import { listStripePaymentIntents, fetchStripeObject } from "../services/stripe";
import { cancelReferenceCandidates } from "../services/document-references";
import { stripeStableId } from "../adapters/sources/stripe-source";
import { buildAdapterCtx } from "../services/adapter-ctx";
import { projectConnectionBehaviour } from "../services/connection-context";
import { formatPtDate } from "../ix/date";

type OrderResult = {
  external_id: string;
  status: "created" | "finalized" | "skipped" | "error" | "dry_run";
  message: string;
};

interface StripeConnConfig {
  restricted_key?: string;
  stripe_account_id?: string;
  webhook_secret?: string;
  webhook_endpoint_id?: string;
}

interface StripeConnFull {
  destinationKind: string;
  sourceConfig: StripeConnConfig;
  destinationConfig: Record<string, any> | undefined;
}

// Full connection view for recovery ops: destination + both config blobs, so a
// re-emit routes to the SAME destination the live webhook path would (Moloni,
// Vendus, …) instead of the IX-only default. Mirrors processStripeBatch.
async function loadStripeConnectionFull(env: Env, userId: string): Promise<StripeConnFull | null> {
  const row: any = await env.DB.prepare(
    "SELECT destination_kind, source_config_json, destination_config_json FROM connections WHERE user_id = ? AND source_kind = 'stripe' LIMIT 1"
  ).bind(userId).first();
  if (!row) return null;
  const parse = (s: string | null): Record<string, any> | undefined => { try { return s ? JSON.parse(s) : undefined; } catch { return undefined; } };
  return {
    destinationKind: row.destination_kind ?? "invoicexpress",
    sourceConfig: (parse(row.source_config_json) ?? {}) as StripeConnConfig,
    destinationConfig: parse(row.destination_config_json),
  };
}

// The externalId the pipeline dedups on for a given event payload.
//
// This MUST be the same rule StripeSource.externalId applies, otherwise a force
// re-emit deletes the wrong dedup key: a card payment fires BOTH charge.succeeded
// and payment_intent.succeeded, and the pipeline keys the processed_orders row
// (D1 + KV) on the PAYMENT INTENT. Re-emitting by the charge id must therefore
// also resolve to the PI, or `force` clears a `ch_…` key that was never written
// and the pipeline skips the real `pi_…` row as "Already processed".
//
// It is now a re-export rather than a hand-maintained copy of those five lines,
// which is what it used to be — and copies of an idempotency rule drift apart,
// which is exactly how "Order #0" survived unnoticed for months.
export const externalIdFromEvent = stripeStableId;

export interface StripeBackfillOptions {
  dry_run?: boolean;
  since_last_processed?: boolean;
  notify_emails?: string[];
  triggered_by?: string | null;
  reason?: string | null;
  from?: string;
  to?: string;
}

export async function processStripeBackfill(
  env: Env,
  config: IRequestConfig,
  options: StripeBackfillOptions,
) {
  const appStorage = new AppStorage(env, config.shopify_domain ?? undefined, config.user_id);
  const dryRun = !!options.dry_run;

  // Full connection view so backfill routes to the SAME destination the live
  // webhook path would (Moloni/Vendus/IX). Loading source-only used to force
  // destination:"invoicexpress" below, which silently mis-issued a Moloni
  // connection's backfilled payments to InvoiceXpress.
  const conn = await loadStripeConnectionFull(env, config.user_id);
  const connCfg = conn?.sourceConfig;
  if (!conn || !connCfg?.restricted_key) {
    return { error: "No Stripe restricted_key on connection. Save Stripe credentials first." };
  }
  // Non-IX destinations store auto_finalize in destination_config (the wizard writes
  // it there); the pipeline reads config.auto_finalize, so project it — this keeps a
  // healed/backfilled payment a DRAFT when the client hasn't opted into auto-finalize.
  if (conn.destinationConfig && typeof conn.destinationConfig.auto_finalize === "boolean") {
    (config as any).auto_finalize = conn.destinationConfig.auto_finalize ? 1 : 0;
  }

  let effectiveFrom = options.from;
  let effectiveTo = options.to ?? new Date().toISOString();
  if (options.since_last_processed) {
    const last = await appStorage.getLastProcessedDateByUser(config.user_id, "stripe");
    effectiveFrom = last ?? (effectiveFrom ?? "2020-01-01T00:00:00Z");
  }
  if (!effectiveFrom || !effectiveTo) {
    return { error: "Either from/to date range or since_last_processed is required" };
  }

  const jobId = crypto.randomUUID();
  await appStorage.startDevJob({
    id: jobId,
    type: dryRun ? "stripe_backfill_dry_run" : "stripe_backfill",
    params: { from: effectiveFrom, to: effectiveTo, options },
    triggered_by: options.triggered_by ?? null,
    reason: options.reason ?? null,
  });

  let pis: any[];
  try {
    pis = await listStripePaymentIntents(connCfg.restricted_key, effectiveFrom, effectiveTo, 500, connCfg.stripe_account_id);
  } catch (e: any) {
    const summary = { error: String(e) };
    await appStorage.finishDevJob(jobId, "error", summary, []);
    return { job_id: jobId, ...summary };
  }

  const ids = pis.map(pi => String(pi.id));
  // Freshness gate excludes not only already-invoiced payments but also those an
  // operator hand-matched or marked "não necessária" (NOT_NEEDED) — otherwise a
  // re-run (esp. the nightly heal) would resurrect an invoice they deliberately
  // excluded. See AppStorage.getResolvedOrderIds.
  const existing = await appStorage.getResolvedOrderIds(ids, `u:${config.user_id}`);
  const fresh = pis.filter(pi => !existing.has(String(pi.id)));

  const results: OrderResult[] = [];
  for (const pi of fresh) {
    const externalId = String(pi.id);
    if (dryRun) {
      results.push({ external_id: externalId, status: "dry_run", message: `Would create invoice for ${externalId}` });
      continue;
    }
    try {
      const event = { type: "payment_intent.succeeded", data: { object: pi }, ...(connCfg.stripe_account_id ? { account: connCfg.stripe_account_id } : {}) };
      await runAdapterPipeline({
        env, config, source: "stripe",
        destination: (conn.destinationKind as any) ?? "invoicexpress",
        topic: "created", webhookId: null, body: event,
        sourceConfig: connCfg,
        destinationConfig: conn.destinationConfig,
      });
      results.push({ external_id: externalId, status: "created", message: "Invoice created via backfill" });
    } catch (e: any) {
      results.push({ external_id: externalId, status: "error", message: String(e?.message ?? e) });
    }
  }

  // Verify against reality, not against "the pipeline didn't throw".
  //
  // A create can be skipped SILENTLY — the destination's idempotency check
  // matches, a gate declines, the total is zero — and the pipeline still returns
  // normally. Trusting the absence of an exception reported four MY VAN payments
  // as "created" that were never invoiced, and because "created" is a success it
  // left `errors` at zero, so the nightly heal that exists to catch exactly this
  // raised no incident and nobody was told for two days (2026-08-14).
  //
  // So: ask the database whether a document actually landed. Anything claimed as
  // created but absent is downgraded to an error, which is what makes the heal
  // escalate it.
  const claimed = results.filter(r => r.status === "created").map(r => r.external_id);
  if (claimed.length > 0) {
    const landed = await appStorage.getResolvedOrderIds(claimed, `u:${config.user_id}`);
    for (const r of results) {
      if (r.status === "created" && !landed.has(r.external_id)) {
        r.status = "error";
        r.message = "Pipeline finished without issuing a document (silent skip) — payment is STILL unbilled";
      }
    }
  }

  const summary = {
    type: "stripe_backfill",
    dry_run: dryRun,
    total: results.length,
    success: results.filter(r => r.status === "created").length,
    skipped: pis.length - fresh.length,
    errors: results.filter(r => r.status === "error").length,
    would_create: results.filter(r => r.status === "dry_run").length,
    from: effectiveFrom,
    to: effectiveTo,
  };

  const status: "success" | "partial" | "error" = summary.errors === 0
    ? "success"
    : summary.success > 0 || summary.would_create > 0 ? "partial" : "error";

  await appStorage.finishDevJob(jobId, status, summary, results);

  if (options.notify_emails && options.notify_emails.length > 0) {
    await sendDevModeEmail({
      recipients: options.notify_emails,
      subject: `Rioko Dev Mode — Stripe backfill${dryRun ? " (dry-run)" : ""} (${pis.length} PIs)`,
      body: [
        `Job: stripe_backfill${dryRun ? " (dry-run)" : ""}`,
        `User: ${config.user_id}`,
        `Range: ${effectiveFrom} → ${effectiveTo}`,
        `Total PIs in window: ${pis.length}`,
        `Already processed (skipped): ${summary.skipped}`,
        `Success: ${summary.success}`,
        `Errors: ${summary.errors}`,
        dryRun ? `Would create: ${summary.would_create}` : "",
        ``,
        `Job ID: ${jobId}`,
      ].filter(Boolean).join("\n"),
    });
  }

  return { job_id: jobId, ...summary, results };
}

export async function reemitStripeOrder(
  env: Env,
  config: IRequestConfig,
  stripeId: string,
  options: { force?: boolean; reason?: string | null; triggered_by?: string | null; notify_emails?: string[] },
) {
  const appStorage = new AppStorage(env, config.shopify_domain ?? undefined, config.user_id);
  const jobId = crypto.randomUUID();
  await appStorage.startDevJob({
    id: jobId, type: "stripe_reemit",
    params: { stripe_id: stripeId, force: !!options.force },
    triggered_by: options.triggered_by ?? null, reason: options.reason ?? null,
  });

  const conn = await loadStripeConnectionFull(env, config.user_id);
  const connCfg = conn?.sourceConfig;
  if (!conn || !connCfg?.restricted_key) {
    const err = "No Stripe restricted_key on connection";
    await appStorage.finishDevJob(jobId, "error", { error: err }, []);
    return { job_id: jobId, status: "error", error: err };
  }
  // Non-IX destinations store auto_finalize in destination_config (the wizard
  // writes it there); the pipeline reads config.auto_finalize, so project it —
  // this is what keeps a re-emit a DRAFT when the client hasn't opted into
  // auto-finalize (mirrors processStripeBatch).
  if (conn.destinationConfig && typeof conn.destinationConfig.auto_finalize === "boolean") {
    (config as any).auto_finalize = conn.destinationConfig.auto_finalize ? 1 : 0;
  }

  const fetched = await fetchStripeObject(connCfg.restricted_key, stripeId, connCfg.stripe_account_id);
  if ("error" in fetched) {
    await appStorage.finishDevJob(jobId, "error", { error: fetched.error }, []);
    return { job_id: jobId, status: "error", error: fetched.error };
  }
  const event = fetched.event;

  const externalId = externalIdFromEvent(event);

  // A forced re-emit replaces the previous document, so the previous document
  // has to go. Deleting only our DB row (what this used to do) left the old
  // draft standing at the destination forever — the Shopify path has discarded
  // its stale draft since day one, and Stripe silently did not.
  // Only ever a DRAFT. A certified document is a fiscal record: it is corrected
  // with a credit note, never deleted, so it is left standing and said out loud.
  let previousDraft: "discarded" | "kept_finalized" | "none" | "unknown" = "none";
  let previousDocumentId: string | null = null;
  if (options.force) {
    const previous = await appStorage.getInvoiceByOrderId(externalId);
    if (previous?.invoice_id) {
      previousDocumentId = String(previous.invoice_id);
      const dest = await resolveStripeDestination(env, config);
      if (dest.ok && dest.adapter.deleteDraft) {
        try {
          const outcome = await dest.adapter.deleteDraft(previousDocumentId, dest.ctx);
          previousDraft = outcome === "finalized" ? "kept_finalized" : "discarded";
        } catch (e: any) {
          // Tidy-up only: the real work is issuing the replacement, so a failed
          // delete is reported rather than fatal.
          console.warn(`[Rioko] could not discard previous document ${previousDocumentId}: ${e?.message ?? e}`);
          previousDraft = "unknown";
        }
      } else {
        previousDraft = "unknown";
      }
    }
    await appStorage.deleteProcessedInvoice(externalId, "stripe");
  }

  // The operator is about to hold two documents for one payment. Say so in the
  // same words the Shopify path uses, rather than burying it in a status enum.
  const forceWarning =
    previousDraft === "kept_finalized"
      ? `ATENÇÃO: ${previousDocumentId} já estava finalizado e foi mantido — emita nota de crédito se for duplicado`
      : previousDraft === "unknown" && previousDocumentId
        ? `ATENÇÃO: não foi possível confirmar o estado do documento anterior ${previousDocumentId} — verifique antes de dar por concluído`
        : null;

  try {
    await runAdapterPipeline({
      env, config, source: "stripe",
      destination: (conn.destinationKind as any) ?? "invoicexpress",
      topic: "created", webhookId: null, body: event,
      sourceConfig: connCfg,
      destinationConfig: conn.destinationConfig,
      // The document under this reference is the one being replaced.
      skipReferenceCheck: !!options.force,
    });
  } catch (e: any) {
    const err = `Pipeline failed: ${e?.message ?? e}`;
    await appStorage.finishDevJob(jobId, "error", { error: err }, []);
    return { job_id: jobId, status: "error", error: err };
  }

  const summary = {
    external_id: externalId,
    stripe_id: stripeId,
    force: !!options.force,
    previous_document: previousDraft,
    previous_document_id: previousDocumentId,
    ...(forceWarning ? { warning: forceWarning } : {}),
  };
  await appStorage.finishDevJob(jobId, "success", summary, [summary]);

  if (options.notify_emails && options.notify_emails.length > 0) {
    await sendDevModeEmail({
      recipients: options.notify_emails,
      subject: `Rioko Dev Mode — Stripe re-emit ${stripeId}`,
      body: `Stripe id: ${stripeId}\nExternal id: ${externalId}\nForce: ${options.force ? "yes" : "no"}\nReason: ${options.reason ?? "—"}\nJob ID: ${jobId}${forceWarning ? `\n\n${forceWarning}` : ""}`,
    });
  }

  return { job_id: jobId, status: "success", ...summary };
}

/**
 * Everything a recovery op needs to talk to whatever destination this Stripe
 * connection actually writes to.
 *
 * The three functions below used to build InvoiceXpress headers straight off the
 * legacy config, which meant "delete this Stripe draft" on a Stripe→Moloni
 * connection tried to delete an InvoiceXpress document with a null account name.
 * They now go through the destination adapter, so the connection decides.
 */
async function resolveStripeDestination(env: Env, config: IRequestConfig): Promise<
  | { ok: true; destination: DestinationKind; adapter: DestinationAdapter; ctx: AdapterCtx }
  | { ok: false; error: string }
> {
  const conn = await loadStripeConnectionFull(env, config.user_id);
  if (!conn) return { ok: false, error: `No Stripe connection for user ${config.user_id}` };

  const destination = (conn.destinationKind as DestinationKind) ?? "invoicexpress";
  // The connection's own auto_finalize/send_email must win for its own traffic.
  projectConnectionBehaviour(config, conn.destinationConfig);

  const { ctx } = await buildAdapterCtx(env, {
    config,
    source: "stripe",
    destination,
    sourceConfig: conn.sourceConfig,
    destinationConfig: conn.destinationConfig,
  });
  return { ok: true, destination, adapter: getDestinationAdapter(destination), ctx };
}

/** The destination document id we recorded for a Stripe payment. */
async function lookupStripeInvoiceId(
  env: Env,
  config: IRequestConfig,
  externalId: string,
): Promise<{ error: string } | { invoiceId: string }> {
  const appStorage = new AppStorage(env, config.shopify_domain ?? undefined, config.user_id);
  const invoiceRef = await appStorage.getInvoiceByOrderId(externalId);
  // A row with no invoice_id is a record of an attempt, not of a document.
  if (!invoiceRef?.invoice_id) return { error: `No invoice registered for ${externalId}` };
  return { invoiceId: String(invoiceRef.invoice_id) };
}

export async function deleteStripeDraft(
  env: Env,
  config: IRequestConfig,
  stripeId: string,
  options: { reason?: string | null; triggered_by?: string | null; notify_emails?: string[] },
) {
  const appStorage = new AppStorage(env, config.shopify_domain ?? undefined, config.user_id);
  const jobId = crypto.randomUUID();
  await appStorage.startDevJob({
    id: jobId, type: "stripe_delete_draft",
    params: { stripe_id: stripeId },
    triggered_by: options.triggered_by ?? null, reason: options.reason ?? null,
  });

  const fail = async (error: string) => {
    await appStorage.finishDevJob(jobId, "error", { error }, []);
    return { job_id: jobId, status: "error", error };
  };

  const lookup = await lookupStripeInvoiceId(env, config, stripeId);
  if ("error" in lookup) return fail(lookup.error);

  const dest = await resolveStripeDestination(env, config);
  if (!dest.ok) return fail(dest.error);
  if (!dest.adapter.deleteDraft) {
    return fail(`${dest.destination} does not support deleting drafts — issue a credit note instead.`);
  }

  let outcome: "deleted" | "already_gone" | "finalized";
  try {
    outcome = await dest.adapter.deleteDraft(lookup.invoiceId, dest.ctx);
  } catch (e: any) {
    // An unreadable document is NOT a deleted one: clearing our record here
    // would let the next backfill mint a duplicate against a live document.
    return fail(`Delete failed for document ${lookup.invoiceId}: ${e?.message ?? e}`);
  }

  if (outcome === "finalized") {
    return fail(`Document ${lookup.invoiceId} is certified — use issue-credit-note instead of delete-draft.`);
  }

  await appStorage.deleteProcessedInvoice(stripeId, "stripe");
  const summary = {
    invoice_id: lookup.invoiceId,
    external_id: stripeId,
    destination: dest.destination,
    ...(outcome === "already_gone"
      ? { message: `Document already gone at ${dest.destination} — removed the stale DB link.` }
      : {}),
  };
  await appStorage.finishDevJob(jobId, "success", summary, [summary]);

  if (options.notify_emails && options.notify_emails.length > 0) {
    await sendDevModeEmail({
      recipients: options.notify_emails,
      subject: `Rioko Dev Mode — Stripe draft eliminado ${stripeId}`,
      body: `Documento ${lookup.invoiceId} (${dest.destination}) eliminado.\nStripe id: ${stripeId}\nReason: ${options.reason ?? "—"}\nTriggered by: ${options.triggered_by ?? "—"}\nJob ID: ${jobId}`,
    });
  }

  return { job_id: jobId, status: "success", ...summary };
}

export async function issueStripeCreditNote(
  env: Env,
  config: IRequestConfig,
  stripeId: string,
  options: { reason?: string | null; triggered_by?: string | null; notify_emails?: string[] },
) {
  const appStorage = new AppStorage(env, config.shopify_domain ?? undefined, config.user_id);
  const jobId = crypto.randomUUID();
  await appStorage.startDevJob({
    id: jobId, type: "stripe_issue_credit_note",
    params: { stripe_id: stripeId },
    triggered_by: options.triggered_by ?? null, reason: options.reason ?? null,
  });

  const fail = async (error: string) => {
    await appStorage.finishDevJob(jobId, "error", { error }, []);
    return { job_id: jobId, status: "error", error };
  };

  const lookup = await lookupStripeInvoiceId(env, config, stripeId);
  if ("error" in lookup) return fail(lookup.error);

  const dest = await resolveStripeDestination(env, config);
  if (!dest.ok) return fail(dest.error);
  if (!dest.adapter.creditFullDocument) {
    return fail(`${dest.destination} cannot issue a credit note for an existing document yet.`);
  }

  // Keeps writing the historical `StripeCancel <id>` spelling — renaming a
  // fiscal document's reference is not a refactor. The match list carries the
  // unified spelling too, so a document credited under either is never credited
  // twice.
  const reference = `StripeCancel ${stripeId}`;
  let result;
  try {
    result = await dest.adapter.creditFullDocument(lookup.invoiceId, dest.ctx, {
      reference,
      matchReferences: cancelReferenceCandidates("stripe", stripeId),
      reason: options.reason ?? null,
    });
  } catch (e: any) {
    return fail(String(e?.message ?? e));
  }

  const summary = {
    invoice_id: lookup.invoiceId,
    credit_note_id: result.creditId,
    external_id: stripeId,
    destination: dest.destination,
    ...(result.alreadyExisted ? { message: "Credit note already exists, skipped" } : {}),
  };
  await appStorage.finishDevJob(jobId, "success", summary, [summary]);

  if (options.notify_emails && options.notify_emails.length > 0) {
    await sendDevModeEmail({
      recipients: options.notify_emails,
      subject: `Rioko Dev Mode — Stripe credit note ${stripeId}`,
      body: `Nota de crédito ${result.creditId} emitida para o documento ${lookup.invoiceId} (${dest.destination}).\nStripe id: ${stripeId}\nReason: ${options.reason ?? "—"}\nTriggered by: ${options.triggered_by ?? "—"}\nJob ID: ${jobId}`,
    });
  }

  return { job_id: jobId, status: "success", ...summary };
}

export async function finalizeStripeDrafts(
  env: Env,
  config: IRequestConfig,
  options: {
    dry_run?: boolean;
    limit?: number;
    triggered_by?: string | null;
    reason?: string | null;
    notify_emails?: string[];
    date_strategy?: FinalizeDateStrategy;
    from_date?: string | null;
    to_date?: string | null;
  },
) {
  const appStorage = new AppStorage(env, config.shopify_domain ?? undefined, config.user_id);
  const limit = Math.min(options.limit ?? 100, 500);
  const dryRun = !!options.dry_run;
  const strategy: FinalizeDateStrategy = options.date_strategy ?? "closest_available";
  const fromDate = options.from_date ?? null;
  const toDate = options.to_date ?? null;
  const jobId = crypto.randomUUID();
  await appStorage.startDevJob({
    id: jobId,
    type: dryRun ? "stripe_finalize_drafts_dry_run" : "stripe_finalize_drafts",
    params: { limit, dry_run: dryRun, date_strategy: strategy, from_date: fromDate, to_date: toDate },
    triggered_by: options.triggered_by ?? null,
    reason: options.reason ?? null,
  });

  const results: Array<{ external_id: string; invoice_id: string; status: "finalized" | "dry_run" | "skipped" | "error"; message: string; original_date?: string; target_date?: string }> = [];

  const dest = await resolveStripeDestination(env, config);
  if (!dest.ok) {
    await appStorage.finishDevJob(jobId, "error", { error: dest.error }, []);
    return { job_id: jobId, total: 0, finalized: 0, skipped: 0, errors: 1, would_finalize: 0, dry_run: dryRun, date_strategy: strategy, results: [], error: dest.error };
  }
  if (!dest.adapter.finalizeWithDate) {
    const error = `${dest.destination} has no draft dating to negotiate — nothing to finalize.`;
    await appStorage.finishDevJob(jobId, "error", { error }, []);
    return { job_id: jobId, total: 0, finalized: 0, skipped: 0, errors: 1, would_finalize: 0, dry_run: dryRun, date_strategy: strategy, results: [], error };
  }

  let processed = await appStorage.listProcessedInvoicesByUser(config.user_id, "stripe", limit, "asc");
  if ((fromDate || toDate) && processed.length > 0) {
    processed = processed.filter(r => {
      const created = r.created_at ?? "";
      if (fromDate && created < fromDate) return false;
      if (toDate && created > toDate) return false;
      return true;
    });
  }

  // One batch for the whole run: the destination fetches its series baseline and
  // tax table once, and advances the baseline as documents are certified.
  const batch = dest.adapter.prepareFinalizeBatch
    ? await dest.adapter.prepareFinalizeBatch(dest.ctx, { strategy })
    : undefined;

  for (const row of processed) {
    try {
      const outcome = await dest.adapter.finalizeWithDate(row.invoice_id, dest.ctx, {
        strategy,
        batch,
        dryRun,
        dateMovedNote: (originalDate) =>
          `Fatura referente ao pagamento Stripe ${row.id} de ${formatPtDate(originalDate)}`,
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

  const summary = {
    total: results.length,
    finalized: results.filter(r => r.status === "finalized").length,
    skipped: results.filter(r => r.status === "skipped").length,
    errors: results.filter(r => r.status === "error").length,
    would_finalize: results.filter(r => r.status === "dry_run").length,
    dry_run: dryRun,
    date_strategy: strategy,
  };
  const status: "success" | "partial" | "error" = summary.errors === 0
    ? "success"
    : summary.finalized > 0 || summary.would_finalize > 0 ? "partial" : "error";
  await appStorage.finishDevJob(jobId, status, summary, results);

  if (options.notify_emails && options.notify_emails.length > 0) {
    await sendDevModeEmail({
      recipients: options.notify_emails,
      subject: `Rioko Dev Mode — Stripe finalize drafts${dryRun ? " (dry-run)" : ""}`,
      body: `Total: ${summary.total}\nStrategy: ${strategy}\nFinalized: ${summary.finalized}\nSkipped: ${summary.skipped}\nErrors: ${summary.errors}${dryRun ? `\nWould finalize: ${summary.would_finalize}` : ""}\nJob ID: ${jobId}`,
    });
  }

  return { job_id: jobId, ...summary, results };
}
