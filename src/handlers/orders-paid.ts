import type { Env } from "../env";
import type { IRequestConfig } from "../storage";
import { AppStorage } from "../storage";
import { IxApi } from "../api/ix";
import { ixCall } from "../ix/ix-call";
import { awaitInvoiceVisibility } from "../utils";
import { checkSubscriptionGate } from "../services/subscription-gate";
import { isIntegrationPaused } from "../services/pause-gate";
import { handleOrderCreated } from "./orders-created";

export async function handleOrderPaid(env: Env, config: IRequestConfig, webhookId: string | null, order: any) {
  const webhookTopic = "orders/paid";
  const appStorage = new AppStorage(env, config.shopify_domain!);

  const orderId = order.id;
  console.log(`[Rioko] Order received: ${orderId}`);
  console.log(order);

  // Pause switch — must come before the subscription gate so a paused
  // user with an active subscription still short-circuits silently.
  if (await isIntegrationPaused(env, config, webhookTopic, orderId)) return;

  // Subscription gate: block IX emission if user's Kapta subscription inactive (admins exempt)
  const gate = await checkSubscriptionGate(env, config);
  if (!gate.allowed) {
    console.log(`[Rioko] Subscription gate blocked order ${orderId}: ${gate.reason}`);
    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: String(orderId), response: `Blocked: ${gate.reason}`, status: 402 });
    return;
  }

  await awaitInvoiceVisibility();

  try {
    // NOTE: finalize does NOT need the normalized order — it only needs the
    // invoice row (looked up by the raw order id below) and the IX doc id. The
    // old normalize call here was dead work whose only observable effect was to
    // FAIL the finalize on a transient Shopify hiccup (and, under
    // NORMALIZE_IN_WORKER, an extra raw Shopify fetch). Dropped.

    // Look up the invoice by the RAW order id — the same key orders/created
    // persists with (avoid normalized.order.id, which can diverge).
    let invoice = await appStorage.getInvoiceByOrderId(String(orderId));

    // Self-heal: a missing row means orders/created never ran, failed, or found
    // an existing IX doc it didn't track. Run the create flow (idempotent — it
    // checks IX by reference and now links the existing doc) and re-look-up,
    // instead of throwing into a permanent retry storm.
    if (!invoice || !invoice.invoice_id) {
      console.log(`[Rioko] No invoice row for order ${orderId}; self-healing via create flow`);
      await handleOrderCreated(env, config, null, order);
      invoice = await appStorage.getInvoiceByOrderId(String(orderId));
    }

    if (!invoice || !invoice.invoice_id) {
      // Still nothing — create legitimately produced no invoice (zero-amount,
      // VIES-deferred, or a hard failure already logged by handleOrderCreated).
      console.log(`[Rioko] Order ${orderId} has no invoice after self-heal — nothing to finalize`);
      await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: String(orderId), response: "No invoice after self-heal (zero-amount/deferred/failed)", status: 200 });
      if (webhookId) await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "success");
      return;
    }

    // Check if auto_finalize is enabled
    const finalize = config.auto_finalize === 1;

    // Skip if we don't auto-finalize invoices
    if (!finalize) {
      console.log(`[Rioko] Auto-finalize disabled, skipping for order ${orderId}`);
      await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: JSON.stringify({ orderId, invoiceId: invoice.invoice_id }), response: "Auto-finalize disabled", status: 200 });
      return;
    }

    const ixHeaders = {
      "x-account-name": config.ix_account_name!,
      "x-api-key": config.ix_api_key!,
      "x-env": config.ix_environment === "production" ? "prod" as const : "dev" as const,
    };

    // Finalize the invoice (timeout + retry: a hung finalize would otherwise
    // stall the queue consumer to the Worker wall-clock limit).
    const { data, error } = await ixCall(
      () => IxApi.v2.changeState.post({
        body: {
          type: config.ix_document_type === "invoice_receipt" ? "invoice_receipt" : "invoice",
          id: Number(invoice.invoice_id),
          state: "finalized"
        },
        headers: ixHeaders
      }),
      { isOk: (r) => !r.error, label: `finalize ${invoice.invoice_id}` },
    );

    console.log(`[Rioko] Invoice finalized for order ${orderId}`, { data, error });

    // Mark webhook as processed
    if (webhookId) {
      await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "success");
    }

    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: JSON.stringify({ orderId, invoiceId: invoice.invoice_id }), response: "Finalized", status: 200 });

    if (config.ix_send_email) {
      const { data: invoiceData, error: invoiceError } = await ixCall(
        () => IxApi.v2.documents.byId.get({
          headers: ixHeaders,
          path: {
            id: Number(invoice.invoice_id)
          }
        }),
        { isOk: (r) => !r.error, label: `get ${invoice.invoice_id}` },
      );

      if (invoiceError) {
        console.error(`[Rioko] Failed to get invoice by id ${invoice.invoice_id}:`, invoiceError);
        throw new Error(`Failed to get invoice by id ${invoice.invoice_id}`);
      }

      // if (!invoiceData.data.client.email || !invoiceData.data.client.fiscal_id) {
      if (!invoiceData.data.client.email) {
        // console.error(`[Rioko] Invoice ${invoice.invoice_id} has no email address or nif`);
        console.error(`[Rioko] Invoice ${invoice.invoice_id} has no email address`);
        return;
      }

      const { error } = await ixCall(
        () => IxApi.v2.documents.byId.email.post({
          body: {
            message: {
              client: {
                email: invoiceData.data.client.email,
                save: "0"
              },
              body: config.ix_email_body ?? undefined,
              subject: config.ix_email_subject ?? undefined
            }
          },
          path: {
            id: Number(invoice.invoice_id)
          },
          query: {
            type: config.ix_document_type === "invoice_receipt" ? "invoice_receipts" : "invoices"
          },
          headers: ixHeaders
        }),
        { isOk: (r) => !r.error, label: `email ${invoice.invoice_id}` },
      );

      if (error) {
        console.error(`[Rioko] Failed to send invoice by id ${invoice.invoice_id}:`, error);
        throw new Error(`Failed to send invoice by id ${invoice.invoice_id}`);
      }
    }
  } catch (e) {
    console.error(`[Rioko] Error finalizing invoice for order ${orderId}:`, e);

    // Mark webhook as failed
    if (webhookId) {
      await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "failed");
    }

    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: String(e), status: 500 });
    throw e;
  }
}
