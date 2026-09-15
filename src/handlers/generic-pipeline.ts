import type { Env } from "../env";
import type { IRequestConfig, SourceKind, DestinationKind } from "../storage";
import { AppStorage } from "../storage";
import { getSourceAdapter, getDestinationAdapter } from "../adapters/registry";
import type { AdapterCtx, DestinationCreditResult } from "../adapters/types";
import { checkSubscriptionGate } from "../services/subscription-gate";
import { isIntegrationPaused } from "../services/pause-gate";
import { decideVat } from "../adapters/tax-rates";
import { reportIncident, type Severity } from "../services/incidents";
import type { IncidentKind } from "../services/email-templates";
import { destinationHandlesForeignCurrency } from "../services/currency-guard";
import { matchTagRouting, normalizeRule, applyTagRoute, parseStoredRoute, type NormalizedRoute } from "../services/tag-routing";
import { describeOrder } from "../services/order-label";
import { getIxDocumentPermalink } from "../services/ix-document-email";
import { refundReference, documentReference } from "../services/document-references";
import { buildAdapterCtx } from "../services/adapter-ctx";
import { logDocumentEvent, explainPlatformError } from "../services/document-log";
import { connectionLabelOf } from "../services/connection-context";
import { runInHoldsFinalize } from "../services/run-in";
import { httpStatusOf } from "../services/platform-error";
import { isIxValidationRefusal } from "../adapters/destinations/ix-finalize";
import { extractPtNif, simplifiedInvoiceBlocker, SIMPLIFIED_INVOICE_MAX_TOTAL } from "../adapters/destinations/moloni-destination";
import { forcedDocTypeForSettlement } from "../services/lodgify-amounts";

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
    // The legacy Shopify→IX handler phrases the same refusal differently
    // ("Failed to create invoice for order N: {IX body}"). Without this the
    // message matched nothing, fell through to the default destination_reject
    // /non-permanent branch — the one branch exempted from the transient
    // give-up — so a bad NIF ground all 10 attempts into the DLQ, where the
    // incident carries no error text at all.
    || msg.includes("failed to create invoice")
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
    if (looksPermanent4xx(msg) || isIxValidationRefusal(msg)) {
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
    // A field validation is not a 4xx we can see: the proxy forwards IX's own
    // wording inside a 200 envelope, so the status never reaches the message.
    // Without this, "O total não pode ser superior ao total dos documentos
    // relacionados" — a refusal that is identical on every attempt — kept the
    // full ten-retry budget, and every attempt left another draft behind.
    if (looksPermanent4xx(msg) || isIxValidationRefusal(msg)) {
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
/**
 * The claim bucket for a source, or null when that source must not be claimed.
 *
 * Scoped by user because a Stripe or EuPago connection has no shop domain, and
 * an unscoped claim would put every such account in one bucket.
 *
 * Lodgify is absent on purpose: its instalments issue several documents against
 * the same booking id, so a claim keyed on that id would block the second
 * instalment instead of a duplicate.
 */
export function claimScopeFor(source: string, userId?: string | null): string | null {
  const CLAIMED_SOURCES = new Set(["stripe", "stripe_connect", "eupago"]);
  return CLAIMED_SOURCES.has(source) && userId ? `u:${userId}` : null;
}

export async function runAdapterPipeline(input: RunPipelineInput): Promise<void> {
  const { env, config, source, destination, topic, webhookId, body } = input;

  const sourceAdapter = getSourceAdapter(source);
  const destAdapter = getDestinationAdapter(destination);
  const externalId = sourceAdapter.externalId(body);
  // BOTH keys, always. Passing only the shop domain leaves every row this
  // pipeline writes for a connection-based source (Stripe, Lodgify, EuPago)
  // owned by nobody: they have no shopify_domain by nature, so the row lands
  // with both scope columns NULL. `processed_orders`, `logs` and `webhook_info`
  // were all affected, which is why listProcessedInvoicesByUser found nothing
  // for a Moloni-only client and finalize-drafts reported zero drafts on a
  // merchant that had them.
  const appStorage = new AppStorage(env, config.shopify_domain ?? undefined, config.user_id);

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
  const gate = await checkSubscriptionGate(env, config, { source, destination });
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
    // "Porque é que esta venda não foi facturada?" is the most-asked question,
    // and the answer must live on the sale's own timeline, not only in a log row.
    await logDocumentEvent(env, {
      externalId,
      event: "skipped",
      dedupKey: `skipped:gate:${externalId}`,
      userId: config.user_id,
      shopifyDomain: config.shopify_domain,
      sourceKind: source,
      destinationKind: destination,
      actor: "pipeline",
      summary: `Venda ${externalId} não facturada: subscrição inactiva (${gate.reason}). A Conciliação apanha-a quando a subscrição regularizar.`,
      detail: { reason: gate.reason },
    });
    return;
  }

  // 2. One document per sale, even when three events describe it.
  //
  // A single Stripe payment fires `checkout.session.completed`,
  // `payment_intent.succeeded` and `charge.succeeded`. They dedup on the same
  // PaymentIntent, but only AFTER a document exists — and the three arrive in
  // parallel, so all three can read "not processed" and all three can create.
  // The Shopify path has claimed orders since the day it minted 60 duplicate
  // drafts; this is the same compare-and-swap, scoped by user because a Stripe
  // connection has no shop domain.
  //
  // Every source whose external id names ONE sale. The restricted-key `stripe`
  // connections were left out of this when it was written, on the grounds that
  // their merchants had arranged around the duplicates. That reasoning expired
  // the moment any of them started finalizing: an unclaimed race used to leave
  // three drafts to delete, and now leaves three certified documents and two
  // credit notes. Measured on Wim Hof Method, 14/09/2026, hours before that
  // connection moved to `stripe_connect`: two sales, six documents.
  //
  // Lodgify is deliberately absent. Its instalments issue several documents
  // against the same booking id on purpose, so a claim keyed on that id would
  // block the second instalment rather than a duplicate.
  const claimScope = claimScopeFor(source, config.user_id);
  if (claimScope && !await appStorage.claimOrder(externalId, undefined, claimScope)) {
    // Throw rather than ack, for the reason spelled out in orders-created: if the
    // holder died, acking here would consume the redelivery that was the sale's
    // last chance to be invoiced.
    console.log(`[Pipeline] ${externalId} is claimed by another delivery — retrying`);
    throw new Error(`${externalId} is claimed by another delivery — retrying`);
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
        // A refund failure gets a bucket of its own. Merged with a sale failure
        // of the same connection and hour, the bucket took whichever topic wrote
        // last, and the evidence check could close it on the sale's invoice with
        // no credit note (review, 15/09/2026).
        ...(topic === "refund" ? { dedup_key: "refund" } : {}),
        detail: { message: (err as any)?.message, http_status: httpStatusOf(err), raw: (err as any)?.raw, field: (err as any)?.field, orderRef, clientName, externalId, topic, source, destination },
        affected_ids: [externalId],
        connection_label: connectionLabel,
        order_ref: orderRef,
        client_name: clientName,
      });
    }

    if (permanent) {
      // The definitive refusal, in the platform's own words. Transient errors
      // are deliberately NOT written here — the queue retries them and the
      // final outcome is what counts; three attempts are transport noise.
      if (topic === "created") {
        await logDocumentEvent(env, {
          externalId,
          event: "create_failed",
          dedupKey: `create_failed:${externalId}:${new Date().toISOString().slice(0, 10)}`,
          userId: config.user_id,
          shopifyDomain: config.shopify_domain,
          sourceKind: source,
          destinationKind: destination,
          actor: "pipeline",
          summary: `O destino recusou emitir o documento da venda ${externalId}: ${explainPlatformError(String((err as any)?.message ?? err), destination)}`,
          detail: { kind, message: String((err as any)?.message ?? err).slice(0, 600), http_status: httpStatusOf(err) },
        });
      }
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
  } finally {
    // Released whatever happened: a claim left behind would block the retry of
    // the very delivery that failed. Claims expire on their own after three
    // minutes, so this is a courtesy, not the safety net.
    if (claimScope) await appStorage.releaseOrderClaim(externalId, claimScope);
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
  logCtx?: { env: Env; externalId: string; userId?: string | null; shopifyDomain?: string | null; sourceKind?: string | null; destinationKind?: string | null },
): Promise<void> {
  if (!customerEmailEnabled(config) || !destAdapter.emailDocument) return;
  // Never send a document parked for a human, whatever the destination. The IX
  // adapter re-checks this (and the draft state) itself; Moloni and Vendus have
  // no such gate of their own, so this is the only thing standing between a held
  // document and the buyer's inbox on those paths.
  if (holdReason) return;
  try {
    await destAdapter.emailDocument(invoiceId, ctx, { holdReason });
    if (logCtx) {
      await logDocumentEvent(logCtx.env, {
        externalId: logCtx.externalId,
        event: "emailed",
        dedupKey: `emailed:${invoiceId}`,
        invoiceId,
        userId: logCtx.userId ?? null,
        shopifyDomain: logCtx.shopifyDomain ?? null,
        sourceKind: logCtx.sourceKind ?? null,
        destinationKind: logCtx.destinationKind ?? null,
        actor: "pipeline",
        summary: `Documento ${invoiceId} enviado por email ao comprador.`,
      });
    }
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
  // The real thing, not a structural subset of it. The narrow shape predates
  // `ctx` carrying anything a destination reads back — the VAT decision is
  // written here and read in the InvoiceXpress adapter — and a subset type
  // silently drops whatever it does not name.
  ctx: AdapterCtx,
  logTopic: string,
  connectionLabel: string,
  tagRoutingRules: import("../services/tag-routing").TagRoutingRule[],
): Promise<void> {
  const { env, config, source, destination, topic, webhookId, body } = input;

  // Set on `created` when a tag rule matched, then persisted so the later
  // `paid` and `refund` deliveries can rebuild the same context.
  let routedDecision: NormalizedRoute | null = null;

  // Is this sale ours at all?
  //
  // BEFORE the topic is even considered. A sale another system invoices is not
  // ours to issue a document for, and it is not ours to CREDIT either — measured
  // on Escola Lá Fora (14/09/2026): two subscriptions the merchant's own
  // backoffice had invoiced in July (M/565, M/566, both closed) were refunded,
  // and the refund reached a pipeline whose scope check only ran on `created`.
  // It ground through ten attempts looking for an invoice Rioko never issued,
  // gave up, and raised an incident for work that was never its own.
  //
  // Every gate below answers "has RIOKO done this?", and for a second system's
  // document the answer is honestly no — which is how one payment ends up with
  // two fiscal documents and the VAT on it declared twice.
  //
  // A sale Rioko has already issued a document for is settled: it is ours by
  // evidence, so the question is not asked again and no redelivery pays for a
  // Stripe round-trip to re-answer it.
  const alreadyOurs = await appStorage.isInvoiceAlreadyProcessed(externalId, source);
  const notOurs = !alreadyOurs && sourceAdapter.scopeBlocker
    ? await sourceAdapter.scopeBlocker(body, ctx)
    : null;
  if (notOurs) {
    if (webhookId) await appStorage.markWebhookAsProcessed(webhookId, logTopic as any, "success");
    await logDocumentEvent(env, {
      externalId,
      event: "skipped",
      dedupKey: `skipped:scope:${topic}:${externalId}`,
      userId: config.user_id,
      shopifyDomain: config.shopify_domain,
      sourceKind: source,
      destinationKind: destination,
      actor: "pipeline",
      summary: `Venda ${externalId} não facturada pelo Rioko: ${notOurs}.`,
      detail: { reason: notOurs, topic },
    });
    await appStorage.saveLog({
      shopify_domain: config.shopify_domain,
      topic: logTopic,
      payload: externalId,
      response: `Skipped: out of scope — ${notOurs}`,
      status: 200,
    });
    return;
  }

  switch (topic) {
    case "created": {
      if (alreadyOurs) {
        await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: logTopic, payload: externalId, response: "Already processed", status: 401 });
        return;
      }

      const normalized = await sourceAdapter.toNormalized(body, ctx);
      if (!normalized) throw new Error(`[Pipeline] Failed to normalize ${logTopic} ${externalId}`);

      // Decide the VAT ourselves, when the connection asks us to.
      //
      // Here, and not in the destination adapters, because `item.tax` +
      // `unit_price` is the one contract all three read — Vendus reads nothing
      // else — and because a rewrite of the normalized order reaches the credit
      // note by the same path.
      //
      // This is also the ONE place the regime is decided. It used to be two:
      // the rate here, from the shipping country, and the exemption code later
      // inside the InvoiceXpress adapter, from the billing country — which meant
      // the two could disagree, and that neither reverse charge nor a named
      // regime ever reached Moloni or Vendus at all.
      //
      // Silent unless the connection declared a registration.
      const vat = await decideVat(normalized, ctx, destination);
      ctx.vat = vat;
      if (vat.changed > 0 || vat.regime === "reverse_charge" || vat.regime === "export") {
        console.log(`[Pipeline] ${externalId}: ${vat.regime} (${vat.country}), ${vat.changed} line(s) re-rated`);
      }

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
        const ref = documentReference(normalized.order);
        const found = await destAdapter.findByReference(ref, ctx);
        if (found) {
          await logDocumentEvent(env, {
            externalId,
            event: "skipped",
            dedupKey: `skipped:exists:${externalId}`,
            userId: config.user_id,
            shopifyDomain: config.shopify_domain,
            sourceKind: source,
            destinationKind: destination,
            actor: "pipeline",
            summary: `Não emitido: o destino já tinha um documento com a referência ${ref}.`,
            detail: { reference: ref },
          });
          await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: logTopic, payload: externalId, response: "Already exists at destination", status: 401 });
          return;
        }
      }

      // Tag routing: override the destination's document type, series and
      // draft-vs-finalize when the order carries a tag matching a
      // merchant-configured rule. applyTagRoute owns the per-destination key
      // mapping — see src/services/tag-routing.ts.
      const tagMatch = matchTagRouting(normalized.order, tagRoutingRules, {
        byCountry: ctx.config.tag_route_by_country === 1,
      });
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

      // A stay paid in part is issued as a FATURA, whatever the rules said.
      //
      // Deliberately after tag routing, and deliberately overriding it: a
      // Fatura/Recibo asserts that the money came in, and on
      // `invoice_plus_receipts` half of it has not — the payments are recorded
      // afterwards, each as its own Recibo. Expressing this as a per-merchant
      // routing rule failed twice over: `matchTagRouting` returns the FIRST rule
      // by created_at, so a merchant with older `property_id:*` rules matches
      // those instead, and a merchant put on the mode without the rule gets the
      // wrong document with nothing to warn anyone. Fiscal correctness must not
      // depend on the order rows were inserted in.
      if (destination === "moloni" && forcedDocTypeForSettlement(normalized.order, ctx.destinationConfig)) {
        routedDecision = {
          docType: "invoice",
          finalize: routedDecision?.finalize ?? null,
          series: routedDecision?.series ?? null,
        };
        ctx = applyTagRoute(ctx, destination, routedDecision);
      }

      // Currency guard. Which destinations can take a foreign-currency sale, and
      // why, lives in destinationHandlesForeignCurrency — the short version is
      // that Moloni issues in the paid currency and InvoiceXpress restates the
      // sale in euros at the ECB rate before building. Vendus still cannot, and
      // is the one this stops.
      const currency = String(normalized.order?.currency ?? "EUR").toUpperCase();
      if (currency && currency !== "EUR" && !destinationHandlesForeignCurrency(destination)) {
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
        await logDocumentEvent(env, {
          externalId,
          event: "skipped",
          dedupKey: `skipped:currency:${externalId}`,
          userId: config.user_id,
          shopifyDomain: config.shopify_domain,
          sourceKind: source,
          destinationKind: destination,
          actor: "pipeline",
          summary: `Venda ${externalId} não facturada: pagamento em ${currency}, e este destino só emite em EUR.`,
          detail: { currency },
        });
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
        await logDocumentEvent(env, {
          externalId,
          event: "skipped",
          dedupKey: `skipped:zero:${externalId}`,
          userId: config.user_id,
          shopifyDomain: config.shopify_domain,
          sourceKind: source,
          destinationKind: destination,
          actor: "pipeline",
          summary: `Venda ${externalId} não facturada: total de valor zero — não é exigido documento (a loja não tem invoice_zero_total).`,
          detail: { total: orderTotal },
        });
        await appStorage.saveLog({
          shopify_domain: config.shopify_domain,
          topic: logTopic,
          payload: JSON.stringify({ externalId, total: orderTotal }),
          response: "Skipped: zero-amount order — no invoice required",
          status: 200,
        });
        return;
      }

      const { invoiceId, holdReason: draftHold, exemptionCode } = await destAdapter.createDraft(normalized, ctx);
      // A rate the engine could not apply holds the document too: it goes out
      // at the rate actually charged, as a draft, and the merchant is told why.
      // Emitting it certified would put a rate we know to be wrong on a fiscal
      // document; refusing it outright would leave a paid sale unbilled with a
      // message that names neither cause.
      const holdReason = [draftHold, vat.holdReason].filter(Boolean).join(" · ") || null;
      await appStorage.saveProcessedInvoice(externalId, invoiceId, {
        sourceKind: source,
        destinationKind: destination,
        holdReason,
        routedJson: routedDecision ? JSON.stringify(routedDecision) : null,
      });

      // Record WHAT WE SENT, so the 04:00 sweep can hold the destination to it.
      //
      // Verification itself is not done here. It reads the document back, and
      // doing that inline adds one read per document to a component this
      // codebase documents as collapsing under load — worse, this function is
      // called in a LOOP by the reconciliation sweep and every admin backfill,
      // so a hundred-order backfill became a hundred extra reads in a burst.
      // That is the exact shape that took the proxy down before.
      //
      // But deferring the read means the intent is gone by the time anyone
      // checks, so it is written down here instead: one local D1 insert, no
      // network. The exemption code is whatever the destination says it stamped
      // at document level: InvoiceXpress puts exactly one on the document, and
      // recording it is what lets the sweep catch the M99 class of drift — a
      // document created under a named legal reason that IX later reads back
      // with none. A destination that derives the reason per line (Moloni) has
      // no single value to be held to and reports none, which reads here as the
      // null this field carried for every document until now.
      await logDocumentEvent(env, {
        externalId,
        event: "built",
        dedupKey: `built:${invoiceId}`,
        invoiceId,
        userId: config.user_id,
        shopifyDomain: config.shopify_domain,
        sourceKind: source,
        destinationKind: destination,
        actor: "pipeline",
        summary: `Documento ${invoiceId} emitido no destino por ${Number(normalized.order?.total ?? 0).toFixed(2)} € com a referência ${documentReference(normalized.order)}.`,
        detail: {
          intent: {
            total: Number.isFinite(Number(normalized.order?.total)) ? Number(normalized.order?.total) : null,
            reference: documentReference(normalized.order),
            exemptionCode: exemptionCode ?? null,
          },
          holdReason: holdReason ?? null,
        },
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
        await logDocumentEvent(env, {
          externalId,
          event: "held",
          dedupKey: `held:${invoiceId}`,
          invoiceId,
          userId: config.user_id,
          shopifyDomain: config.shopify_domain,
          sourceKind: source,
          destinationKind: destination,
          actor: "pipeline",
          summary: `Documento ${invoiceId} ficou retido em rascunho para revisão: ${holdReason}. Corrigir a encomenda e reemitir é o que limpa a retenção.`,
          detail: { invoiceId, holdReason },
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
      // A connection authorised against Stripe's TEST mode never certifies.
      // A finalized document is AT-communicated and cannot be unmade except by
      // a credit note, so the one thing a sandbox must not be able to produce
      // is a real one. Drafts are the entire point of testing.
      const isTestConnection = (ctx.sourceConfig as any)?.livemode === false;
      // A Stripe Connect connection whose merchant has never confirmed a
      // document keeps issuing drafts, whatever it — or a tag rule — asks for.
      // Read HERE and not off `ctx.config`, because `applyTagRoute` rewrites
      // `auto_finalize` on the context and a `finalize_mode='finalize'` rule
      // would otherwise walk straight past the run-in.
      const runInHold = await runInHoldsFinalize(env, source, config.user_id, destination);
      const finalizeInSameFlow = !sourceAdapter.capabilities.emitsSeparatePaidEvent
        && ctx.config.auto_finalize === 1 && !holdReason && !isTestConnection && !runInHold;
      let response = holdReason
        ? `Created (draft — ${holdReason})`
        : (runInHold && ctx.config.auto_finalize === 1 ? "Created (draft — rodagem por confirmar)" : "Created");
      if (finalizeInSameFlow) {
        await destAdapter.finalize(invoiceId, ctx);
        await logDocumentEvent(env, {
          externalId,
          event: "finalized",
          dedupKey: `finalized:${invoiceId}`,
          invoiceId,
          userId: config.user_id,
          shopifyDomain: config.shopify_domain,
          sourceKind: source,
          destinationKind: destination,
          actor: "pipeline",
          summary: `Documento ${invoiceId} fechado no destino — é agora um documento fiscal definitivo.`,
        });
        await emailDocumentBestEffort(destAdapter, invoiceId, ctx, config, holdReason,
          { env, externalId, userId: config.user_id, shopifyDomain: config.shopify_domain, sourceKind: source, destinationKind: destination });
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
      if (!invoice?.invoice_id) {
        // Payment confirmed for a sale nothing ever created a document for.
        //
        // On a source whose events ARE the sale, that is not a missing step to
        // wait for — it is the whole sale arriving at once. A Stripe invoice the
        // merchant marks as paid outside Stripe (a transfer, cash, a booking
        // settled at the counter) fires `invoice.paid` and nothing else: there
        // is no PaymentIntent and no charge, so no create event will ever come,
        // and the money went uninvoiced with only a log line to show for it.
        //
        // Shopify still throws. There `paid` genuinely follows a `created` we
        // must have missed, the retry is what heals it, and creating here would
        // race the delivery that is already on its way.
        if (sourceAdapter.capabilities.emitsSeparatePaidEvent) {
          throw new Error(`[Pipeline] Invoice not found for ${logTopic} ${externalId}`);
        }
        console.log(`[Pipeline] ${externalId}: paid with no document — issuing it now`);
        await runPipelineCore(
          { ...input, topic: "created" },
          sourceAdapter, destAdapter, externalId, appStorage, ctx, logTopic, connectionLabel, tagRoutingRules,
        );
        return;
      }

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

      // A sandbox connection never certifies, on THIS branch too.
      //
      // The guard was written on `created` alone, which left the hole it was
      // built to close: a test-mode event arriving as `paid` — an
      // `invoice.paid`, or any Shopify-shaped source that separates the two —
      // walked past it and closed the draft for real. A finalized document is
      // AT-communicated and undoable only by credit note, out of money that
      // does not exist.
      if ((ctx.sourceConfig as any)?.livemode === false) {
        await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: logTopic, payload: JSON.stringify({ externalId, invoiceId: invoice.invoice_id }), response: "Ligação de teste — mantido em rascunho", status: 200 });
        return;
      }

      // The same run-in hold as the `created` branch, and after the stored route
      // for the same reason. Both branches or neither: a gate only one of them
      // applies is exactly the shape of the livemode bug above.
      if (await runInHoldsFinalize(env, source, config.user_id, destination)) {
        await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: logTopic, payload: JSON.stringify({ externalId, invoiceId: invoice.invoice_id }), response: "Rodagem por confirmar — mantido em rascunho", status: 200 });
        return;
      }

      // Already closed: nothing left for `paid` to do.
      //
      // A card-paid Stripe invoice sends `invoice.paid` AFTER the
      // `payment_intent.succeeded` that already created and finalized its
      // document. InvoiceXpress refused the second finalize ("cannot change a
      // InvoiceReceipt in status 'settled'") on every retry, and the dead-letter
      // queue raised a critical "Encomenda NÃO foi facturada" for WHM on
      // 15/09/2026 (pi_3UFvliLXiybx6Vcz1667s22k, pi_3UFwnHLXiybx6Vcz1xyyLQRY),
      // two sales that were invoiced.
      //
      // Read the state instead of matching the refusal text: a draft still goes
      // to finalize, so a genuine refusal still surfaces; canceled or deleted
      // fall through unchanged; a failed read throws and the queue retries. And
      // the finalized event and the buyer email below never run twice.
      const current = destAdapter.getDocument ? await destAdapter.getDocument(invoice.invoice_id, ctx) : null;
      // Positive evidence only: InvoiceXpress reads a missing or unknown status
      // as final, and a document with no number has not been through a close.
      if (current?.state === "finalized" && current.number) {
        if (webhookId) await appStorage.markWebhookAsProcessed(webhookId, logTopic as any, "success");
        await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: logTopic, payload: JSON.stringify({ externalId, invoiceId: invoice.invoice_id }), response: "Already finalized", status: 200 });
        return;
      }

      await destAdapter.finalize(invoice.invoice_id, ctx);
      await logDocumentEvent(env, {
        externalId,
        event: "finalized",
        dedupKey: `finalized:${invoice.invoice_id}`,
        invoiceId: invoice.invoice_id,
        userId: config.user_id,
        shopifyDomain: config.shopify_domain,
        sourceKind: source,
        destinationKind: destination,
        actor: "pipeline",
        summary: `Documento ${invoice.invoice_id} fechado no destino após confirmação do pagamento.`,
      });
      await emailDocumentBestEffort(destAdapter, invoice.invoice_id, ctx, config, invoice.hold_reason,
        { env, externalId, userId: config.user_id, shopifyDomain: config.shopify_domain, sourceKind: source, destinationKind: destination });

      if (webhookId) await appStorage.markWebhookAsProcessed(webhookId, logTopic as any, "success");
      await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: logTopic, payload: JSON.stringify({ externalId, invoiceId: invoice.invoice_id }), response: "Finalized", status: 200 });
      return;
    }

    case "refund": {
      const normalized = await sourceAdapter.toNormalized(body, ctx);
      if (!normalized) throw new Error(`[Pipeline] Failed to normalize ${logTopic} ${externalId}`);

      const invoice = await appStorage.getInvoiceByOrderId(externalId);
      if (!invoice?.invoice_id) throw new Error(`[Pipeline] Invoice not found for refund of ${externalId}`);
      const invoiceId = String(invoice.invoice_id);
      const { orderRef, clientName } = describeOrder(body);

      // A credit note only corrects a FINALIZED document. A held draft has
      // nothing to correct — the merchant edits or deletes it. A plain draft is
      // caught by the destination's own read of the document, below.
      if (invoice.hold_reason) {
        await reportIncident(env, {
          user_id: config.user_id,
          severity: "warning",
          kind: "credit_note_on_draft",
          dedup_key: invoiceId,
          summary: `Reembolso em ${orderRef ?? externalId} não gerou nota de crédito porque o documento ${invoiceId} está em rascunho retido (${invoice.hold_reason}). Corrija ou apague o rascunho.`,
          detail: { externalId, invoiceId, holdReason: invoice.hold_reason, source, destination },
          affected_ids: [externalId],
          connection_label: connectionLabel,
          order_ref: orderRef,
          client_name: clientName,
        });
        await logDocumentEvent(env, {
          externalId,
          event: "skipped",
          dedupKey: `skipped:credit_held:${invoiceId}`,
          invoiceId,
          userId: config.user_id,
          shopifyDomain: config.shopify_domain,
          sourceKind: source,
          destinationKind: destination,
          actor: "pipeline",
          summary: `Reembolso sem nota de crédito: o documento ${invoiceId} está em rascunho retido (${invoice.hold_reason}) e um rascunho corrige-se, não se credita.`,
          detail: { invoiceId, holdReason: invoice.hold_reason },
        });
        if (webhookId) await appStorage.markWebhookAsProcessed(webhookId, logTopic as any, "success");
        await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: logTopic, payload: JSON.stringify({ externalId, invoiceId }), response: `Skipped credit note: held draft (${invoice.hold_reason})`, status: 200 });
        return;
      }

      // Same as `paid`: the credit note must be raised against the document
      // collection and series the original was routed to, not the connection
      // default. The finalize half of the route is irrelevant here — a credit
      // note is always finalized — but applying the whole route keeps one path.
      const refundRoute = parseStoredRoute(invoice.routed_json);
      if (refundRoute) ctx = applyTagRoute(ctx, destination, refundRoute);

      // One credit note per refund, decided by our own ledger — the one the
      // Shopify path writes too (AppStorage.claimRefundCredit). This used to be
      // decided by asking the destination for the reference, and a read that
      // fails answers "none": that is how one Bikini Books refund became 22
      // credit notes. Keyed per account, like the Shopify path, so the two paths
      // see each other's notes against the same document.
      const ledgerScope = config.user_id || config.shopify_domain || "";
      // A sale invoiced in another money than it was paid in credits the refunded
      // share of its document — see refundInDocumentMoney.
      const paidAbroad = (normalized.order as any).paid_in_foreign_currency;
      const converted = !!paidAbroad || String(normalized.order.currency ?? "EUR").toUpperCase() !== "EUR";
      const saleTotal = Number(paidAbroad?.amount ?? normalized.order.total);

      let issuedCount = 0;
      let skippedCount = 0;
      // Sequentially: two refunds of one sale are each measured against what the
      // other has already taken off the document.
      for (const credit of normalized.credits) {
        const refundId = credit.refund_id;
        const reference = refundReference(refundId);
        const money = Math.round(Number(credit.amount) * 100) / 100;

        const claim = await appStorage.claimRefundCredit(ledgerScope, refundId, invoiceId, money);
        if (claim.status === "blocked") {
          throw new Error(
            `[Pipeline] Não consegui ler o registo de notas de crédito para o reembolso ${refundId} — não emito às cegas.`,
          );
        }
        if (claim.status !== "won") {
          skippedCount++;
          continue;
        }

        // Refusing is an outcome, never a throw: a throw sends the refund back
        // through the queue, and nothing about a refund that cannot be mirrored
        // changes by trying again.
        const refuse = async (reason: string, detail: Record<string, unknown> = {}, opts: { incident?: boolean } = {}) => {
          console.warn(`[Pipeline] Refund ${refundId} on ${externalId}: ${reason}`);
          await appStorage.markRefundCreditRefused(ledgerScope, refundId, reason);
          if (opts.incident !== false) {
            await reportIncident(env, {
              user_id: config.user_id,
              severity: "warning",
              kind: "credit_note_not_mirrored",
              dedup_key: String(refundId),
              summary: `Reembolso de ${money.toFixed(2)} € em ${orderRef ?? externalId} sem nota de crédito: ${reason}. `
                + `O documento ${invoiceId} tem de ser creditado à mão.`,
              detail: { externalId, invoiceId, refundId: String(refundId), amount: money, source, destination, ...detail },
              affected_ids: [externalId],
              connection_label: connectionLabel,
              order_ref: orderRef,
              client_name: clientName,
            });
          }
          await logDocumentEvent(env, {
            externalId,
            event: "skipped",
            dedupKey: `skipped:credit_not_mirrored:${refundId}`,
            invoiceId,
            userId: config.user_id,
            shopifyDomain: config.shopify_domain,
            sourceKind: source,
            destinationKind: destination,
            actor: "pipeline",
            summary: `Reembolso ${refundId} sem nota de crédito: ${reason}.`,
            detail: { refundId: String(refundId), amount: money, reason },
          });
          skippedCount++;
        };

        let result: DestinationCreditResult;
        try {
          // A document already under this reference: issued by another route, or
          // a draft an older attempt left behind — Moloni's lookup matches drafts
          // too. Never a twin beside it, and never counted as credited on a
          // lookup alone; the ledger records why, and nobody is paged for it.
          const existing = destAdapter.findByReference ? await destAdapter.findByReference(reference, ctx) : null;
          if (existing) {
            await refuse(
              `já existe no destino o documento ${existing.id} com a referência ${reference}`,
              { existingId: existing.id },
              { incident: false },
            );
            continue;
          }
          const alreadyCredited = await appStorage.creditedTotalForInvoice(ledgerScope, invoiceId);
          if (alreadyCredited == null) {
            throw new Error(
              `[Pipeline] Não consegui somar as notas de crédito já emitidas sobre ${invoiceId} — não emito sem saber quanto já foi creditado.`,
            );
          }
          result = await destAdapter.issueCredit(invoiceId, { refundId, grossAmount: money, saleTotal, converted, alreadyCredited }, ctx);
        } catch (e: any) {
          const message = String(e?.message ?? e);
          if (e?.strandedCreditId) {
            // A draft is sitting at the destination. Naming it on the row is what
            // stops the next delivery from putting a twin beside it.
            await appStorage.noteRefundCreditDraft(
              ledgerScope, refundId, e.strandedCreditId,
              `rascunho ${e.strandedCreditId} não certificado e não removido: ${message}`,
            );
          } else if (e?.refusal === true || isIxValidationRefusal(message) || /validation errors/i.test(message)) {
            // The destination refused the document itself, and will refuse it
            // identically on every retry.
            await refuse(`o destino recusou a nota de crédito: ${message.slice(0, 300)}`);
            continue;
          } else {
            await appStorage.releaseRefundCredit(ledgerScope, refundId);
          }
          throw e;
        }

        if (result.status === "refused") {
          if (result.documentState === "draft") {
            // Not final: once the document is certified, a replay should credit
            // it, so the row is given back rather than closed.
            await appStorage.releaseRefundCredit(ledgerScope, refundId);
            await reportIncident(env, {
              user_id: config.user_id,
              severity: "warning",
              kind: "credit_note_on_draft",
              dedup_key: invoiceId,
              summary: `Reembolso em ${orderRef ?? externalId} não gerou nota de crédito porque o documento ${invoiceId} está em rascunho. Finalize-o ou apague-o.`,
              detail: { externalId, invoiceId, refundId: String(refundId), amount: money, source, destination },
              affected_ids: [externalId],
              connection_label: connectionLabel,
              order_ref: orderRef,
              client_name: clientName,
            });
            await logDocumentEvent(env, {
              externalId,
              event: "skipped",
              dedupKey: `skipped:credit_draft:${invoiceId}`,
              invoiceId,
              userId: config.user_id,
              shopifyDomain: config.shopify_domain,
              sourceKind: source,
              destinationKind: destination,
              actor: "pipeline",
              summary: `Reembolso sem nota de crédito: o documento ${invoiceId} é um rascunho, e um rascunho corrige-se, não se credita.`,
              detail: { invoiceId, refundId: String(refundId) },
            });
            skippedCount++;
            continue;
          }
          await refuse(result.reason, result.detail, { incident: !result.nothingToCredit });
          continue;
        }
        if (result.status !== "issued") {
          await appStorage.releaseRefundCredit(ledgerScope, refundId);
          throw new Error(`[Pipeline] issueCredit answered "${result.status}" outside a dry run`);
        }

        await appStorage.markRefundCredited(ledgerScope, refundId, result.creditId, result.total);
        issuedCount++;
        await logDocumentEvent(env, {
          externalId,
          event: "credit_issued",
          dedupKey: `credit_issued:${refundId}`,
          invoiceId,
          userId: config.user_id,
          shopifyDomain: config.shopify_domain,
          sourceKind: source,
          destinationKind: destination,
          actor: "pipeline",
          summary: `Nota de crédito ${result.creditId} emitida por ${result.total.toFixed(2)} € sobre o documento ${invoiceId} (reembolso ${refundId}, referência ${reference}).`,
          detail: { refundId, amount: result.total, refunded: money, creditId: result.creditId, reference },
        });
      }

      if (webhookId) await appStorage.markWebhookAsProcessed(webhookId, logTopic as any, "success");
      await appStorage.saveLog({
        shopify_domain: config.shopify_domain,
        topic: logTopic,
        payload: JSON.stringify({ externalId, credits: normalized.credits.length, issued: issuedCount, skipped: skippedCount }),
        response: skippedCount > 0 ? `Credit notes: ${issuedCount} issued, ${skippedCount} skipped` : "Credit notes issued",
        status: 200,
      });
      return;
    }
  }
}
