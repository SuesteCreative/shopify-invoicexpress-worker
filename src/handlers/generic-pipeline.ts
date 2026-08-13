import type { Env } from "../env";
import type { IRequestConfig, SourceKind, DestinationKind } from "../storage";
import { AppStorage } from "../storage";
import { getSourceAdapter, getDestinationAdapter } from "../adapters/registry";
import { checkSubscriptionGate } from "../services/subscription-gate";
import { isIntegrationPaused } from "../services/pause-gate";
import { reportIncident, type Severity } from "../services/incidents";
import type { IncidentKind } from "../services/email-templates";
import { matchTagRouting, normalizeRule, applyTagRoute, parseStoredRoute, type NormalizedRoute } from "../services/tag-routing";
import { describeOrder } from "../services/order-label";
import { getIxDocumentPermalink } from "../services/ix-document-email";
import { saleReference, refundReference } from "../services/document-references";
import { buildAdapterCtx } from "../services/adapter-ctx";
import { connectionLabelOf } from "../services/connection-context";
import { extractPtNif, simplifiedInvoiceBlocker, SIMPLIFIED_INVOICE_MAX_TOTAL } from "../adapters/destinations/moloni-destination";

export type CanonicalTopic = "created" | "paid" | "refund";

export interface RunPipelineInput {
  env: Env;
  config: IRequestConfig;
  source: SourceKind;
  destination: DestinationKind;
  topic: CanonicalTopic;
  webhookId: string | null;
  body: any;
  // Optional parsed `connections.source_config_json`. The Stripe adapter uses
  // it to read the restricted_key for Customer.tax_ids expansion.
  sourceConfig?: Record<string, any>;
  // Optional parsed `connections.destination_config_json`. Moloni/Vendus pull
  // their credentials from here. IX still reads from `config` (legacy row).
  destinationConfig?: Record<string, any>;
  /**
   * Skip the "does the destination already hold this reference?" guard.
   *
   * Set only by a forced re-emit, where a document under that reference is
   * exactly what the operator is replacing and the guard would refuse the very
   * work they asked for. The processed_orders dedup still applies unless the
   * caller cleared that too.
   */
  skipReferenceCheck?: boolean;
}

/**
 * Classify an error from the pipeline into an incident kind + severity +
 * `permanent` flag. `permanent: true` means the same payload will NEVER
 * succeed by retrying (bad NIF, wrong credentials, broken invoice math) —
 * the caller should record the incident, ack the queue message, and stop.
 * Heuristics over error.message — refine over time as new failure modes surface.
 */
// A destination error mentioning a 4xx status (or bad-request wording) won't
// resolve on retry — the document is invalid, not the connection. Treat as
// permanent so we fail fast instead of grinding through the full retry budget.
function looksPermanent4xx(msg: string): boolean {
  return /\b(400|403|404|409|422)\b/.test(msg) || msg.includes("bad request") || msg.includes("unprocessable");
}

export function classifyPipelineError(err: any): { kind: IncidentKind; severity: Severity; permanent: boolean } {
  const msg = String(err?.message ?? err ?? "").toLowerCase();

  // Note: an invalid tax id in address line 2 no longer reaches here. The
  // builder used to refuse to produce a document at all; it now issues the
  // document as a draft and flags it (see `NifHold`), so that case is handled
  // on the success path, not as an error.

  // Reconcile-or-throw guard fired: the invoice total didn't match source paid.
  // Permanent — the math doesn't change between retries; merchant must override
  // a SKU price or fix Shopify data, then manually reemit.
  if (msg.includes("invoice total mismatch")) {
    return { kind: "reconcile_drift", severity: "critical", permanent: true };
  }

  // Empty-document guard fired: the builder produced zero line items (a
  // normalization gap). Retrying the same payload can't add items — fail fast
  // so it surfaces as a real-time alert instead of grinding the retry budget.
  if (msg.includes("has no line items")) {
    return { kind: "normalize_fail", severity: "critical", permanent: true };
  }

  // Destination rejected the document outright (most common: invalid NIF, invalid client)
  const isDestCreateError =
    msg.includes("invoicexpress create failed")
    || msg.includes("invoicexpress credit create failed")
    || (msg.includes("moloni") && msg.includes("fail"))
    || (msg.includes("vendus") && msg.includes("fail"));
  if (isDestCreateError) {
    if (msg.includes("fiscal") || msg.includes("nif")) {
      // Bumped to critical: previously waited for the daily digest, but a bad
      // NIF blocks the entire invoice — merchant should hear about it now.
      return { kind: "nif_invalid", severity: "critical", permanent: true };
    }
    if (msg.includes("401") || msg.includes("unauthorized") || msg.includes("autenticação") || msg.includes("auth")) {
      return { kind: "auth_failure_destination", severity: "critical", permanent: true };
    }
    if (looksPermanent4xx(msg)) {
      return { kind: "destination_reject", severity: "critical", permanent: true };
    }
    // Could be Moloni 5xx or transient destination outage — let the queue retry.
    return { kind: "destination_reject", severity: "error", permanent: false };
  }

  if (
    msg.includes("invoicexpress finalize failed")
    || (msg.includes("moloni") && msg.includes("finalize"))
    || (msg.includes("vendus") && msg.includes("finalize"))
  ) {
    if (looksPermanent4xx(msg)) {
      return { kind: "destination_reject", severity: "critical", permanent: true };
    }
    return { kind: "destination_reject", severity: "error", permanent: false };
  }

  // Shopify order was deleted — normalization can never succeed. Permanent, so
  // we ack once with an incident instead of burning the whole retry budget.
  if (msg.includes("not found in shopify") || msg.includes("unable to fetch order")) {
    return { kind: "normalize_fail", severity: "warning", permanent: true };
  }

  if (msg.includes("failed to normalize")) {
    return { kind: "normalize_fail", severity: "warning", permanent: false };
  }

  if (msg.includes("invoice not found")) {
    // Likely paid/refund arrived before created — should self-heal via retry.
    return { kind: "normalize_fail", severity: "info", permanent: false };
  }

  return { kind: "destination_reject", severity: "error", permanent: false };
}

/**
 * Adapter-routed pipeline. Phase 3 wires this for Stripe-source webhooks; the
 * Shopify legacy handlers continue to run their direct-IxApi path unless
 * env.DESTINATION_VIA_ADAPTER === "1", in which case the queue dispatcher
 * routes Shopify traffic through here as well.
 *
 * Mirrors the orders-created/paid/refunds-create flows but expressed in terms
 * of SourceAdapter + DestinationAdapter so any (source, destination) tuple
 * benefits from the same business logic (gate check, idempotency, NIF, builder).
 */
export async function runAdapterPipeline(input: RunPipelineInput): Promise<void> {
  const { env, config, source, destination, topic, webhookId, body } = input;

  const sourceAdapter = getSourceAdapter(source);
  const destAdapter = getDestinationAdapter(destination);
  const externalId = sourceAdapter.externalId(body);
  const appStorage = new AppStorage(env, config.shopify_domain ?? undefined);

  const { ctx, tagRoutingRules } = await buildAdapterCtx(env, {
    config, source, destination,
    sourceConfig: input.sourceConfig,
    destinationConfig: input.destinationConfig,
  });
  const logTopic = `${source}/${topic}`;
  const connectionLabel = connectionLabelOf(source, destination);

  // 1a. Pause switch — merchant-controlled kill switch, runs before the
  // subscription gate so paused integrations short-circuit even for paying users.
  if (await isIntegrationPaused(env, config, logTopic, externalId)) return;

  // 1. Subscription gate (applies to every destination/source)
  const gate = await checkSubscriptionGate(env, config);
  if (!gate.allowed) {
    console.log(`[Pipeline] Subscription gate blocked ${logTopic} ${externalId}: ${gate.reason}`);
    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: logTopic, payload: String(externalId), response: `Blocked: ${gate.reason}`, status: 402 });
    // Surface as critical — payment came in but we're not invoicing. Merchant needs to act.
    await reportIncident(env, {
      user_id: config.user_id,
      severity: "critical",
      kind: "subscription_inactive",
      summary: `Subscrição inactiva (${gate.reason}). Encomenda ${externalId} não foi facturada.`,
      affected_ids: [externalId],
      connection_label: connectionLabel,
    });
    return;
  }

  try {
    await runPipelineCore(input, sourceAdapter, destAdapter, externalId, appStorage, ctx, logTopic, connectionLabel, tagRoutingRules ?? []);
  } catch (err) {
    const { kind, severity, permanent } = classifyPipelineError(err);

    // P1: paid/refund-before-created is self-healing via queue retry. Logging
    // only — no incident row, no digest noise. DLQ still catches the genuinely
    // stuck ones via `queue_retry_exhausted`.
    const isSelfHealingNormalize = kind === "normalize_fail" && severity === "info";

    if (!isSelfHealingNormalize) {
      const { orderRef, clientName } = describeOrder(body);
      const orderLabel = orderRef ?? externalId;
      await reportIncident(env, {
        user_id: config.user_id,
        severity,
        kind,
        summary: `${logTopic} ${orderLabel}${clientName ? ` — ${clientName}` : ""}: ${(err as any)?.message ?? String(err)}`.slice(0, 500),
        // `raw`/`field` are set by InvalidAddressNifError so the merchant email
        // can quote the exact address-line-2 value that blocked the invoice.
        detail: { message: (err as any)?.message, raw: (err as any)?.raw, field: (err as any)?.field, orderRef, clientName, externalId, topic, source, destination },
        affected_ids: [externalId],
        connection_label: connectionLabel,
        order_ref: orderRef,
        client_name: clientName,
      });
    }

    if (permanent) {
      // Same payload will never succeed. Persist a failure log, ack-by-return,
      // and skip the queue retry storm.
      await appStorage.saveLog({
        shopify_domain: config.shopify_domain,
        topic: logTopic,
        payload: String(externalId),
        response: `Permanent failure (${kind}): ${(err as any)?.message ?? String(err)}`.slice(0, 500),
        status: 422,
      });
      return;
    }

    throw err; // transient — re-throw so queue handler retries
  }
}

/**
 * Does this merchant want the issued document emailed to the buyer?
 *
 * The column is called `ix_send_email` for historical reasons — it predates
 * every destination other than InvoiceXpress — but it is the merchant's single
 * destination-agnostic preference, and the Moloni and Vendus adapters already
 * read its companion `ix_email_subject` / `ix_email_body`. Reading it through
 * one named accessor keeps that honest at every call site instead of leaving an
 * `ix_`-prefixed field being tested on a Moloni order to look like a bug.
 *
 * Note for the Moloni/Vendus rollout: the flag is only exposed in the
 * backoffice on the Shopify→IX page, so merchants on the other destinations
 * cannot turn it on yet even though the pipeline honours it.
 */
export function customerEmailEnabled(config: IRequestConfig): boolean {
  return Number(config.ix_send_email) === 1;
}

/**
 * Send the issued document to the buyer without ever failing the caller.
 *
 * By the time this runs the invoice exists and is finalized. Letting a bounced
 * or refused email throw would fail the webhook, and the retry would re-run
 * finalize on a document that can no longer be edited — a missed email turning
 * into a stream of false finalize errors.
 */
async function emailDocumentBestEffort(
  destAdapter: ReturnType<typeof getDestinationAdapter>,
  invoiceId: string,
  ctx: any,
  config: IRequestConfig,
  holdReason?: string | null,
): Promise<void> {
  if (!customerEmailEnabled(config) || !destAdapter.emailDocument) return;
  // Never send a document parked for a human, whatever the destination. The IX
  // adapter re-checks this (and the draft state) itself; Moloni and Vendus have
  // no such gate of their own, so this is the only thing standing between a held
  // document and the buyer's inbox on those paths.
  if (holdReason) return;
  try {
    await destAdapter.emailDocument(invoiceId, ctx, { holdReason });
  } catch (e: any) {
    console.warn(`[Pipeline] Customer email failed for document ${invoiceId} (non-fatal): ${e?.message ?? e}`);
  }
}

async function runPipelineCore(
  input: RunPipelineInput,
  sourceAdapter: ReturnType<typeof getSourceAdapter>,
  destAdapter: ReturnType<typeof getDestinationAdapter>,
  externalId: string,
  appStorage: AppStorage,
  ctx: { apiKey: string; config: IRequestConfig; sourceConfig?: Record<string, any>; destinationConfig?: Record<string, any> },
  logTopic: string,
  connectionLabel: string,
  tagRoutingRules: import("../services/tag-routing").TagRoutingRule[],
): Promise<void> {
  const { env, config, source, destination, topic, webhookId, body } = input;

  // Set on `created` when a tag rule matched, then persisted so the later
  // `paid` and `refund` deliveries can rebuild the same context.
  let routedDecision: NormalizedRoute | null = null;

  switch (topic) {
    case "created": {
      const alreadyExists = await appStorage.isInvoiceAlreadyProcessed(externalId, source);
      if (alreadyExists) {
        await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: logTopic, payload: externalId, response: "Already processed", status: 401 });
        return;
      }

      const normalized = await sourceAdapter.toNormalized(body, ctx);
      if (!normalized) throw new Error(`[Pipeline] Failed to normalize ${logTopic} ${externalId}`);

      // Defense in depth: does the destination already hold this sale?
      //
      // This runs AFTER normalize on purpose. It used to build the reference from
      // `body.order_number`, a raw-Shopify field that is undefined for Stripe,
      // Lodgify and EuPago — so those sources looked for "Order #pi_3Tp…" while
      // the document had actually been written as "Order #<numeric>", and the
      // check has never once matched for them. The reference has to be the one
      // the destination would write, and only `normalized` knows it.
      //
      // Skipped on a forced re-emit, where the operator's whole intent is to
      // replace a document that does exist (mirrors adminCreateOrder's
      // skipIxReferenceCheck).
      if (destAdapter.findByReference && !input.skipReferenceCheck) {
        const ref = normalized.order.invoice_reference ?? saleReference(normalized.order.order_number);
        const found = await destAdapter.findByReference(ref, ctx);
        if (found) {
          await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: logTopic, payload: externalId, response: "Already exists at destination", status: 401 });
          return;
        }
      }

      // Tag routing: override the destination's document type, series and
      // draft-vs-finalize when the order carries a tag matching a
      // merchant-configured rule. applyTagRoute owns the per-destination key
      // mapping — see src/services/tag-routing.ts.
      const tagMatch = matchTagRouting(normalized.order, tagRoutingRules);
      if (tagMatch) {
        routedDecision = normalizeRule(tagMatch);

        // A simplified invoice is capped at 1.000 € (art. 40.º CIVA) and cannot
        // carry a client record. Rather than let the destination reject the
        // insert — which would retry forever and leave the sale unbilled — we
        // downgrade to a full invoice and tell the merchant why.
        if (routedDecision.docType === "simplified_invoice") {
          const total = Number(normalized.order?.total ?? 0);
          const buyerNif = extractPtNif(normalized);
          const blocker = simplifiedInvoiceBlocker(total, buyerNif);
          if (blocker) {
            const why = blocker === "over_cap"
              ? `o total (${total.toFixed(2)} €) excede o limite de ${SIMPLIFIED_INVOICE_MAX_TOTAL} € da factura simplificada`
              : blocker === "has_nif"
                ? "o cliente indicou NIF, que exige factura completa"
                : "não foi possível determinar o total da venda";
            routedDecision = { ...routedDecision, docType: "invoice" };
            const { orderRef, clientName } = describeOrder(body);
            await reportIncident(env, {
              user_id: config.user_id,
              severity: "warning",
              kind: "simplified_invoice_downgraded",
              dedup_key: externalId,
              summary: `${orderRef ?? externalId} foi facturado como factura normal em vez de simplificada porque ${why}.`,
              detail: { externalId, total, buyerNif, blocker, tag: tagMatch.tag_name, source, destination },
              affected_ids: [externalId],
              connection_label: connectionLabel,
              order_ref: orderRef,
              client_name: clientName,
            });
          }
        }

        ctx = applyTagRoute(ctx, destination, routedDecision);
      }

      // Currency guard. Moloni issues foreign-currency documents natively
      // (exchange_currency_id + exchange_rate — handled in the adapter), so it
      // accepts non-EUR. IX/Vendus have no FX path yet, so we still reject
      // non-EUR there rather than silently issuing a misvalued invoice.
      const currency = String(normalized.order?.currency ?? "EUR").toUpperCase();
      if (currency && currency !== "EUR" && destination !== "moloni") {
        await reportIncident(env, {
          user_id: config.user_id,
          severity: "critical",
          kind: "currency_not_supported",
          summary: `Pagamento em ${currency} para ${externalId} não foi facturado — só EUR é suportado.`,
          detail: { externalId, currency, source, destination },
          affected_ids: [externalId],
          connection_label: connectionLabel,
        });
        if (webhookId) await appStorage.markWebhookAsProcessed(webhookId, logTopic as any, "success");
        await appStorage.saveLog({
          shopify_domain: config.shopify_domain,
          topic: logTopic,
          payload: JSON.stringify({ externalId, currency }),
          response: `Skipped: currency ${currency} not supported (EUR only)`,
          status: 200,
        });
        return;
      }

      // Zero-amount short-circuit. PT fiscal rules don't require invoicing 0€
      // orders and destinations (IX, Moloni, Vendus) reject zero-total payloads.
      // Treat as success-skip so the queue stops retrying.
      // See orders-created.ts: wholesale shops opt in to documenting
      // 100%-discounted orders via `invoice_zero_total`.
      const orderTotal = Number(normalized.order?.total ?? 0);
      if ((!Number.isFinite(orderTotal) || orderTotal <= 0) && Number(config.invoice_zero_total) !== 1) {
        if (webhookId) await appStorage.markWebhookAsProcessed(webhookId, logTopic as any, "success");
        await appStorage.saveLog({
          shopify_domain: config.shopify_domain,
          topic: logTopic,
          payload: JSON.stringify({ externalId, total: orderTotal }),
          response: "Skipped: zero-amount order — no invoice required",
          status: 200,
        });
        return;
      }

      const { invoiceId, holdReason } = await destAdapter.createDraft(normalized, ctx);
      await appStorage.saveProcessedInvoice(externalId, invoiceId, {
        sourceKind: source,
        destinationKind: destination,
        holdReason,
        routedJson: routedDecision ? JSON.stringify(routedDecision) : null,
      });

      // Parked for a human: the buyer's address line 2 held something meant to
      // be a NIF that doesn't validate. The document exists as a draft and the
      // merchant — the only person who can resolve it — is told now, while the
      // order is fresh.
      if (holdReason) {
        const { orderRef, clientName } = describeOrder(body);
        const permalink = destination === "invoicexpress"
          ? await getIxDocumentPermalink(config, invoiceId)
          : null;
        await reportIncident(env, {
          user_id: config.user_id,
          severity: "warning",
          kind: "nif_invalid_draft",
          // One bucket per document — see orders-created.ts.
          dedup_key: invoiceId,
          summary: `A factura ${invoiceId}${orderRef ? `, referente à encomenda ${orderRef},` : ""} ficou em rascunho porque a morada trazia um NIF inválido (${holdReason}).`,
          detail: { invoiceId, holdReason, permalink, orderRef, clientName, externalId, source, destination },
          affected_ids: [externalId],
          connection_label: connectionLabel,
          order_ref: orderRef,
          client_name: clientName,
        });
      }

      // Sources like Stripe Charges have no separate "paid" event — the
      // charge.succeeded event is also the payment confirmation. If the user
      // has auto_finalize on, finalize (and optionally email) in the same flow.
      // Shopify's separate orders/paid webhook is unaffected. A held document
      // is never finalized or emailed here — that is the whole point of the hold.
      //
      // Read off the source's declared capability rather than comparing against
      // the string "shopify", so the next source states its own semantics
      // instead of inheriting whatever this comparison happens to imply.
      const finalizeInSameFlow = !sourceAdapter.capabilities.emitsSeparatePaidEvent
        && ctx.config.auto_finalize === 1 && !holdReason;
      let response = holdReason ? `Created (draft — ${holdReason})` : "Created";
      if (finalizeInSameFlow) {
        await destAdapter.finalize(invoiceId, ctx);
        await emailDocumentBestEffort(destAdapter, invoiceId, ctx, config, holdReason);
        response = "Created+Finalized";
      }

      if (webhookId) await appStorage.markWebhookAsProcessed(webhookId, logTopic as any, "success");
      await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: logTopic, payload: JSON.stringify({ externalId, invoiceId }), response, status: 200 });
      return;
    }

    case "paid": {
      const normalized = await sourceAdapter.toNormalized(body, ctx);
      if (!normalized) throw new Error(`[Pipeline] Failed to normalize ${logTopic} ${externalId}`);

      // Lookup by externalId, which the source adapter controls. For Shopify
      // this is body.id (numeric). For Stripe charges this is the
      // payment_intent so the refund maps back to the same row.
      const invoice = await appStorage.getInvoiceByOrderId(externalId);
      if (!invoice?.invoice_id) throw new Error(`[Pipeline] Invoice not found for ${logTopic} ${externalId}`);

      // Held for a human — leave the draft alone (see the `created` case).
      if (invoice.hold_reason) {
        if (webhookId) await appStorage.markWebhookAsProcessed(webhookId, logTopic as any, "success");
        await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: logTopic, payload: JSON.stringify({ externalId, invoiceId: invoice.invoice_id }), response: `Held as draft: ${invoice.hold_reason}`, status: 200 });
        return;
      }

      // Rebuild the route the draft was created under. Two things depend on it:
      // finalize must target the same document collection the draft lives in,
      // and a rule that said "leave as draft" must survive orders/paid rather
      // than being finalized by the connection's auto_finalize.
      const paidRoute = parseStoredRoute(invoice.routed_json);
      if (paidRoute) ctx = applyTagRoute(ctx, destination, paidRoute);

      if (ctx.config.auto_finalize !== 1) {
        await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: logTopic, payload: JSON.stringify({ externalId, invoiceId: invoice.invoice_id }), response: "Auto-finalize disabled", status: 200 });
        return;
      }

      await destAdapter.finalize(invoice.invoice_id, ctx);
      await emailDocumentBestEffort(destAdapter, invoice.invoice_id, ctx, config, invoice.hold_reason);

      if (webhookId) await appStorage.markWebhookAsProcessed(webhookId, logTopic as any, "success");
      await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: logTopic, payload: JSON.stringify({ externalId, invoiceId: invoice.invoice_id }), response: "Finalized", status: 200 });
      return;
    }

    case "refund": {
      const normalized = await sourceAdapter.toNormalized(body, ctx);
      if (!normalized) throw new Error(`[Pipeline] Failed to normalize ${logTopic} ${externalId}`);

      const invoice = await appStorage.getInvoiceByOrderId(externalId);
      if (!invoice?.invoice_id) throw new Error(`[Pipeline] Invoice not found for refund of ${externalId}`);

      // A credit note only corrects a FINALIZED document. A held draft has
      // nothing to correct — the merchant edits or deletes it. See the same
      // guard in refunds-create.ts, which also catches plain (unheld) drafts
      // because it has the destination document in hand.
      if (invoice.hold_reason) {
        const { orderRef, clientName } = describeOrder(body);
        await reportIncident(env, {
          user_id: config.user_id,
          severity: "warning",
          kind: "credit_note_on_draft",
          dedup_key: String(invoice.invoice_id),
          summary: `Reembolso em ${orderRef ?? externalId} não gerou nota de crédito porque o documento ${invoice.invoice_id} está em rascunho retido (${invoice.hold_reason}). Corrija ou apague o rascunho.`,
          detail: { externalId, invoiceId: invoice.invoice_id, holdReason: invoice.hold_reason, source, destination },
          affected_ids: [externalId],
          connection_label: connectionLabel,
          order_ref: orderRef,
          client_name: clientName,
        });
        if (webhookId) await appStorage.markWebhookAsProcessed(webhookId, logTopic as any, "success");
        await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: logTopic, payload: JSON.stringify({ externalId, invoiceId: invoice.invoice_id }), response: `Skipped credit note: held draft (${invoice.hold_reason})`, status: 200 });
        return;
      }

      // Same as `paid`: the credit note must be raised against the document
      // collection and series the original was routed to, not the connection
      // default. The finalize half of the route is irrelevant here — a credit
      // note is always finalized — but applying the whole route keeps one path.
      const refundRoute = parseStoredRoute(invoice.routed_json);
      if (refundRoute) ctx = applyTagRoute(ctx, destination, refundRoute);

      // Per-credit dedup: query the destination by the canonical credit-note
      // reference. Without this, a re-delivered refund webhook would issue
      // duplicate credit notes — a fiscal-document bug. Mirrors the legacy
      // refunds-create.ts filter that checks existing credit notes first.
      let issuedCount = 0;
      let skippedCount = 0;
      for (const credit of normalized.credits) {
        const reference = refundReference(credit.refund_id);
        if (destAdapter.findByReference) {
          const existing = await destAdapter.findByReference(reference, ctx);
          if (existing) {
            skippedCount++;
            continue;
          }
        }
        // GROSS sum (subtotal + tax) of the returned lines — the credit lines
        // the adapter rebuilds already carry tax, so amountToRefund is only the
        // non-line-item remainder (shipping / cash). Using the net subtotal left
        // Σtax as a phantom extra line, over-crediting by the tax.
        const sum = credit.line_items.reduce((acc, item) => acc + item.subtotal + (item.total_tax ?? 0), 0);
        await destAdapter.issueCredit(invoice.invoice_id, {
          refundId: credit.refund_id,
          itemsIds: credit.line_items.map(li => li.id),
          amountToRefund: credit.amount - sum,
          grossAmount: credit.amount,
        }, normalized, ctx);
        issuedCount++;
      }

      if (webhookId) await appStorage.markWebhookAsProcessed(webhookId, logTopic as any, "success");
      await appStorage.saveLog({
        shopify_domain: config.shopify_domain,
        topic: logTopic,
        payload: JSON.stringify({ externalId, credits: normalized.credits.length, issued: issuedCount, skipped: skippedCount }),
        response: skippedCount > 0 ? `Credit notes: ${issuedCount} issued, ${skippedCount} already existed` : "Credit notes issued",
        status: 200,
      });
      return;
    }
  }
}
