import type { Env } from "../env";
import type { IRequestConfig, SourceKind, DestinationKind } from "../storage";
import { AppStorage } from "../storage";
import { getSourceAdapter, getDestinationAdapter } from "../adapters/registry";
import { checkSubscriptionGate } from "../services/subscription-gate";
import { isIntegrationPaused } from "../services/pause-gate";
import { reportIncident, type Severity } from "../services/incidents";
import type { IncidentKind } from "../services/email-templates";
import { loadProductMappings } from "../services/product-mappings";
import { loadProductOverrides } from "../services/product-overrides";
import { makeViesChecker } from "../ix/vies";

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

  // Reconcile-or-throw guard fired: the invoice total didn't match source paid.
  // Permanent — the math doesn't change between retries; merchant must override
  // a SKU price or fix Shopify data, then manually reemit.
  if (msg.includes("invoice total mismatch")) {
    return { kind: "reconcile_drift", severity: "critical", permanent: true };
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

  // Pre-fetch explicit product mappings (Moloni) + per-SKU overrides (IX).
  // Both are one D1 round-trip with empty-Map fallback when nothing's set.
  const [productMappings, productOverrides] = await Promise.all([
    destination === "moloni" && config.user_id
      ? loadProductMappings(env, config.user_id, source)
      : Promise.resolve(undefined),
    destination === "invoicexpress" && config.user_id
      ? loadProductOverrides(env, config.user_id, source, destination)
      : Promise.resolve(undefined),
  ]);

  // Build VIES checker once per pipeline run when reverse-charge is enabled.
  // Without this, B2B EU customers with valid VAT IDs would get B2C invoices
  // on the adapter path (legacy handlers already pass viesChecker themselves).
  const viesChecker = config.b2b_reverse_charge === 1 ? makeViesChecker(env.INVOICE_KV) : undefined;

  const ctx = {
    apiKey: env.NORMALIZE_SHOPIFY_ORDER_API_KEY,
    config,
    sourceConfig: input.sourceConfig,
    destinationConfig: input.destinationConfig,
    productMappings,
    productOverrides,
    viesChecker,
  };
  const logTopic = `${source}/${topic}`;
  const connectionLabel = `${source} → ${destination}`;

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
    await runPipelineCore(input, sourceAdapter, destAdapter, externalId, appStorage, ctx, logTopic, connectionLabel);
  } catch (err) {
    const { kind, severity, permanent } = classifyPipelineError(err);

    // P1: paid/refund-before-created is self-healing via queue retry. Logging
    // only — no incident row, no digest noise. DLQ still catches the genuinely
    // stuck ones via `queue_retry_exhausted`.
    const isSelfHealingNormalize = kind === "normalize_fail" && severity === "info";

    if (!isSelfHealingNormalize) {
      await reportIncident(env, {
        user_id: config.user_id,
        severity,
        kind,
        summary: `${logTopic} ${externalId}: ${(err as any)?.message ?? String(err)}`.slice(0, 500),
        detail: { message: (err as any)?.message, externalId, topic, source, destination },
        affected_ids: [externalId],
        connection_label: connectionLabel,
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

async function runPipelineCore(
  input: RunPipelineInput,
  sourceAdapter: ReturnType<typeof getSourceAdapter>,
  destAdapter: ReturnType<typeof getDestinationAdapter>,
  externalId: string,
  appStorage: AppStorage,
  ctx: { apiKey: string; config: IRequestConfig; sourceConfig?: Record<string, any>; destinationConfig?: Record<string, any> },
  logTopic: string,
  connectionLabel: string,
): Promise<void> {
  const { env, config, source, destination, topic, webhookId, body } = input;

  switch (topic) {
    case "created": {
      const alreadyExists = await appStorage.isInvoiceAlreadyProcessed(externalId, source);
      if (alreadyExists) {
        await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: logTopic, payload: externalId, response: "Already processed", status: 401 });
        return;
      }

      // Defense in depth: check destination for existing reference
      if (destAdapter.findByReference) {
        const ref = `Order #${body?.order_number ?? externalId}`;
        const found = await destAdapter.findByReference(ref, ctx);
        if (found) {
          await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: logTopic, payload: externalId, response: "Already exists at destination", status: 401 });
          return;
        }
      }

      const normalized = await sourceAdapter.toNormalized(body, ctx);
      if (!normalized) throw new Error(`[Pipeline] Failed to normalize ${logTopic} ${externalId}`);

      // Currency guard: PT accounting must be in EUR. Reject non-EUR payments
      // explicitly rather than silently issuing a misvalued invoice. (Future
      // work: implement FX conversion via balance_transaction.exchange_rate.)
      const currency = String(normalized.order?.currency ?? "EUR").toUpperCase();
      if (currency && currency !== "EUR") {
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
      const orderTotal = Number(normalized.order?.total ?? 0);
      if (!Number.isFinite(orderTotal) || orderTotal <= 0) {
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

      const { invoiceId } = await destAdapter.createDraft(normalized, ctx);
      await appStorage.saveProcessedInvoice(externalId, invoiceId, { sourceKind: source, destinationKind: destination });

      // Sources like Stripe Charges have no separate "paid" event — the
      // charge.succeeded event is also the payment confirmation. If the user
      // has auto_finalize on, finalize (and optionally email) in the same flow.
      // Shopify's separate orders/paid webhook is unaffected.
      const finalizeInSameFlow = source !== "shopify" && config.auto_finalize === 1;
      let response = "Created";
      if (finalizeInSameFlow) {
        await destAdapter.finalize(invoiceId, ctx);
        if (config.ix_send_email && destAdapter.emailDocument) {
          await destAdapter.emailDocument(invoiceId, ctx);
        }
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

      if (config.auto_finalize !== 1) {
        await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: logTopic, payload: JSON.stringify({ externalId, invoiceId: invoice.invoice_id }), response: "Auto-finalize disabled", status: 200 });
        return;
      }

      await destAdapter.finalize(invoice.invoice_id, ctx);
      if (config.ix_send_email && destAdapter.emailDocument) {
        await destAdapter.emailDocument(invoice.invoice_id, ctx);
      }

      if (webhookId) await appStorage.markWebhookAsProcessed(webhookId, logTopic as any, "success");
      await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: logTopic, payload: JSON.stringify({ externalId, invoiceId: invoice.invoice_id }), response: "Finalized", status: 200 });
      return;
    }

    case "refund": {
      const normalized = await sourceAdapter.toNormalized(body, ctx);
      if (!normalized) throw new Error(`[Pipeline] Failed to normalize ${logTopic} ${externalId}`);

      const invoice = await appStorage.getInvoiceByOrderId(externalId);
      if (!invoice?.invoice_id) throw new Error(`[Pipeline] Invoice not found for refund of ${externalId}`);

      // Per-credit dedup: query the destination by the canonical credit-note
      // reference. Without this, a re-delivered refund webhook would issue
      // duplicate credit notes — a fiscal-document bug. Mirrors the legacy
      // refunds-create.ts filter that checks existing credit notes first.
      let issuedCount = 0;
      let skippedCount = 0;
      for (const credit of normalized.credits) {
        const reference = `OrderRefund #${credit.refund_id}`;
        if (destAdapter.findByReference) {
          const existing = await destAdapter.findByReference(reference, ctx);
          if (existing) {
            skippedCount++;
            continue;
          }
        }
        const sum = credit.line_items.reduce((acc, item) => acc + item.subtotal, 0);
        await destAdapter.issueCredit(invoice.invoice_id, {
          refundId: credit.refund_id,
          itemsIds: credit.line_items.map(li => li.id),
          amountToRefund: credit.amount - sum,
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
