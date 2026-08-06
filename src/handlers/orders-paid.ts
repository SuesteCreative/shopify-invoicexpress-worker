import type { Env } from "../env";
import type { IRequestConfig } from "../storage";
import { AppStorage } from "../storage";
import { IxApi } from "../api/ix";
import { ixCall } from "../ix/ix-call";
import { awaitInvoiceVisibility } from "../utils";
import { checkSubscriptionGate } from "../services/subscription-gate";
import { isIntegrationPaused } from "../services/pause-gate";
import { handleOrderCreated } from "./orders-created";
import { sendIxDocumentEmail, describeIxEmailOutcome } from "../services/ix-document-email";

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

    // Parked for a human (invalid NIF in the address line — see orders-created).
    // The draft stays a draft: finalizing it would certify a document whose
    // fiscal identity we know is in question, and emailing it would send the
    // customer an invoice missing the NIF they asked for. The merchant was
    // already told; they resolve it by correcting Shopify and re-emitting.
    if (invoice.hold_reason) {
      console.log(`[Rioko] Order ${orderId} invoice ${invoice.invoice_id} held (${invoice.hold_reason}) — not finalizing`);
      if (webhookId) await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "success");
      await appStorage.saveLog({
        shopify_domain: config.shopify_domain,
        topic: webhookTopic,
        payload: JSON.stringify({ orderId, invoiceId: invoice.invoice_id }),
        response: `Held as draft: ${invoice.hold_reason}`,
        status: 200,
      });
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

    // Send the finalized document to the buyer (opt-in per shop). InvoiceXpress
    // sends it from the merchant's own account, and the body carries the
    // document's quicklink for viewing and downloading the PDF.
    //
    // Deliberately non-fatal. This used to throw, which failed the whole
    // orders/paid webhook AFTER the invoice had already been finalized — the
    // retry then re-ran finalize on a document that could no longer be edited,
    // turning "the email didn't go out" into a stream of false finalize errors.
    const emailOutcome = await sendIxDocumentEmail(config, invoice.invoice_id, { holdReason: invoice.hold_reason });
    console.log(`[Rioko] ${describeIxEmailOutcome(invoice.invoice_id, emailOutcome)}`);
    if (!emailOutcome.sent && (emailOutcome.reason === "send_failed" || emailOutcome.reason === "lookup_failed")) {
      await appStorage.saveLog({
        shopify_domain: config.shopify_domain,
        topic: webhookTopic,
        payload: JSON.stringify({ orderId, invoiceId: invoice.invoice_id }),
        response: describeIxEmailOutcome(invoice.invoice_id, emailOutcome),
        status: 502,
      });
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
