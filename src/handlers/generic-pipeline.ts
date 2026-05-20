import type { Env } from "../env";
import type { IRequestConfig, SourceKind, DestinationKind } from "../storage";
import { AppStorage } from "../storage";
import { getSourceAdapter, getDestinationAdapter } from "../adapters/registry";
import { checkSubscriptionGate } from "../services/subscription-gate";
import { reportIncident, type Severity } from "../services/incidents";
import type { IncidentKind } from "../services/email-templates";

export type CanonicalTopic = "created" | "paid" | "refund";

export interface RunPipelineInput {
  env: Env;
  config: IRequestConfig;
  source: SourceKind;
  destination: DestinationKind;
  topic: CanonicalTopic;
  webhookId: string | null;
  body: any;
}

/**
 * Classify an error from the pipeline into an incident kind + severity.
 * Heuristics over error.message — refine over time as new failure modes surface.
 */
function classifyPipelineError(err: any): { kind: IncidentKind; severity: Severity } {
  const msg = String(err?.message ?? err ?? "").toLowerCase();

  // Destination rejected the document outright (most common: invalid NIF, invalid client)
  if (msg.includes("invoicexpress create failed") || msg.includes("invoicexpress credit create failed") || msg.includes("moloni") && msg.includes("fail")) {
    if (msg.includes("fiscal") || msg.includes("nif")) {
      return { kind: "nif_invalid", severity: "error" };
    }
    if (msg.includes("401") || msg.includes("unauthorized") || msg.includes("autenticação")) {
      return { kind: "auth_failure_destination", severity: "critical" };
    }
    return { kind: "destination_reject", severity: "error" };
  }

  if (msg.includes("invoicexpress finalize failed") || msg.includes("moloni") && msg.includes("finalize")) {
    return { kind: "destination_reject", severity: "error" };
  }

  if (msg.includes("failed to normalize")) {
    return { kind: "normalize_fail", severity: "warning" };
  }

  if (msg.includes("invoice not found")) {
    // Likely paid/refund arrived before created — should self-heal via retry.
    return { kind: "normalize_fail", severity: "info" };
  }

  return { kind: "destination_reject", severity: "error" };
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
  const ctx = { apiKey: env.NORMALIZE_SHOPIFY_ORDER_API_KEY, config };
  const logTopic = `${source}/${topic}`;
  const connectionLabel = `${source} → ${destination}`;

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
    await runPipelineCore(input, sourceAdapter, destAdapter, externalId, appStorage, ctx, logTopic);
  } catch (err) {
    const { kind, severity } = classifyPipelineError(err);
    await reportIncident(env, {
      user_id: config.user_id,
      severity,
      kind,
      summary: `${logTopic} ${externalId}: ${(err as any)?.message ?? String(err)}`.slice(0, 500),
      detail: { message: (err as any)?.message, externalId, topic, source, destination },
      affected_ids: [externalId],
      connection_label: connectionLabel,
    });
    throw err; // re-throw so queue handler retries
  }
}

async function runPipelineCore(
  input: RunPipelineInput,
  sourceAdapter: ReturnType<typeof getSourceAdapter>,
  destAdapter: ReturnType<typeof getDestinationAdapter>,
  externalId: string,
  appStorage: AppStorage,
  ctx: { apiKey: string; config: IRequestConfig },
  logTopic: string,
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

      for (const credit of normalized.credits) {
        const sum = credit.line_items.reduce((acc, item) => acc + item.subtotal, 0);
        await destAdapter.issueCredit(invoice.invoice_id, {
          refundId: credit.refund_id,
          itemsIds: credit.line_items.map(li => li.id),
          amountToRefund: credit.amount - sum,
        }, normalized, ctx);
      }

      if (webhookId) await appStorage.markWebhookAsProcessed(webhookId, logTopic as any, "success");
      await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: logTopic, payload: JSON.stringify({ externalId, credits: normalized.credits.length }), response: "Credit notes issued", status: 200 });
      return;
    }
  }
}
