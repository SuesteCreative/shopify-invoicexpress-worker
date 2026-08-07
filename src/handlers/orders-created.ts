import type { Env } from "../env";
import type { IRequestConfig } from "../storage";
import { AppStorage } from "../storage";
import { Shopify } from "../shopify";
import { IxApi } from "../api/ix";
import { IxBuilder, nifHoldReason, type NifHold } from "../ix/builder";
import { createIxInvoiceWithFallback } from "../ix/create-invoice";
import { maybeSendQuotaReachedAlert } from "../services/quota-alert";
import { makeViesChecker } from "../ix/vies";
import { isIntegrationPaused } from "../services/pause-gate";
import { checkSubscriptionGate } from "../services/subscription-gate";
import { loadProductOverrides } from "../services/product-overrides";
import { reportIncident } from "../services/incidents";
import { describeOrder } from "../services/order-label";
import { getIxDocumentPermalink } from "../services/ix-document-email";

/**
 * Tell the merchant a document was left as a draft because the buyer's address
 * line 2 held something that was meant to be a NIF and did not validate. They
 * are the only person who can resolve it, and only while the order is fresh —
 * so this is a real-time email, not a digest line.
 *
 * Best-effort throughout: the invoice is already created and saved by the time
 * we get here, so nothing in this function may fail the webhook.
 */
async function notifyNifHold(
  env: Env,
  config: IRequestConfig,
  order: any,
  invoiceId: string,
  hold: NifHold,
): Promise<void> {
  try {
    const { orderRef, clientName } = describeOrder(order);
    const permalink = await getIxDocumentPermalink(config, invoiceId);
    await reportIncident(env, {
      user_id: config.user_id,
      // Warning, not critical: the document exists and the money is accounted
      // for. Critical is reserved for orders with no document at all, which
      // page the ops team.
      severity: "warning",
      kind: "nif_invalid_draft",
      // One bucket per document. Without this, a second order held in the same
      // hour joins the first one's bucket and the merchant is never told about
      // it — they would see one email and two stuck drafts.
      dedup_key: invoiceId,
      summary: `A factura ${invoiceId}${orderRef ? `, referente à encomenda ${orderRef},` : ""} ficou em rascunho porque a morada trazia um NIF inválido ("${hold.raw}" em ${hold.field}).`,
      detail: { invoiceId, raw: hold.raw, field: hold.field, permalink, orderRef, clientName, orderId: String(order?.id ?? "") },
      affected_ids: [String(order?.id ?? invoiceId)],
      connection_label: "shopify → invoicexpress",
      order_ref: orderRef,
      client_name: clientName,
    });
  } catch (e: any) {
    console.error(`[Rioko] Failed to report NIF hold for invoice ${invoiceId}: ${e?.message ?? e}`);
  }
}

export async function handleOrderCreated(env: Env, config: IRequestConfig, webhookId: string | null, order: any) {
  const webhookTopic = "orders/created";
  const appStorage = new AppStorage(env, config.shopify_domain!);

  const orderId = order.id;
  console.log(`[Rioko] Order received: ${orderId}`);
  console.log(order);

  // Pause switch: merchant turned the integration off — log and exit.
  if (await isIntegrationPaused(env, config, webhookTopic, orderId)) return;

  // Subscription gate. This has to be HERE, not only on orders/paid, because on
  // the Shopify→IX path creation and finalization live in different webhooks:
  // orders/created makes the document, orders/paid certifies it. With the gate
  // on only one of the two, a blocked shop produced a draft that nothing would
  // ever finalize — which is exactly what the trial-gate outage of 2026-08-01→04
  // did to ~275 orders across the fleet, silently, because the merchant sees a
  // document in InvoiceXpress and assumes it was issued.
  //
  // Blocking BEFORE creation is the honest behaviour: no half-document, and the
  // order is picked up in full by the reconciliation sweep once the subscription
  // is sorted out. The incident (mirroring generic-pipeline) is what turns this
  // from a silent stop into something we and the merchant can see.
  const gate = await checkSubscriptionGate(env, config);
  if (!gate.allowed) {
    console.log(`[Rioko] Subscription gate blocked order ${orderId}: ${gate.reason}`);
    if (webhookId) await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "success");
    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: String(orderId), response: `Blocked: ${gate.reason}`, status: 402 });
    await reportIncident(env, {
      user_id: config.user_id,
      severity: "critical",
      kind: "subscription_inactive",
      summary: `Subscrição inactiva (${gate.reason}). Encomenda ${describeOrder(order).orderRef ?? orderId} não foi facturada.`,
      detail: { orderId: String(orderId), reason: gate.reason },
      affected_ids: [String(orderId)],
      connection_label: "shopify → invoicexpress",
    });
    return;
  }

  // Check if order was already processed.
  const alreadyExists = await appStorage.isInvoiceAlreadyProcessed(orderId);
  if (alreadyExists) {
    console.log(`[Rioko] Invoice already processed for order ${orderId}`);
    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: "Already processed", status: 401 });
    return;
  }

  // Claim the order before doing anything that creates a document.
  //
  // The check above cannot stop a duplicate on its own: it reads, and the write
  // that would make its answer "yes" only happens after a normalize and an IX
  // round-trip. Two `orders/created` deliveries for the same order land in
  // different queue batches that overlap across Worker invocations, so both read
  // "not processed" and both create a document — 60 orphan duplicate drafts on
  // one shop, ids consecutive, seconds apart. The IX reference lookup below does
  // not save it either: a just-created document is not immediately findable by
  // reference, which is exactly why the paid path pads with awaitInvoiceVisibility.
  //
  // `claimOrder` is a compare-and-swap, so exactly one delivery gets through.
  if (!await appStorage.claimOrder(String(orderId))) {
    // THROW, do not ack. Acking here would be right for an ordinary duplicate —
    // the winner is doing the work — but it is fatal in the case that matters:
    // when the holder dies, the queue redelivers ITS message, that redelivery
    // finds the dead holder's claim still warm, and acking would consume the
    // only delivery left. The order would then never be invoiced.
    //
    // Retrying costs one cheap round trip on the duplicate path: by the time it
    // comes back the winner has written processed_orders, so it exits at
    // "Already processed" above.
    console.log(`[Rioko] Order ${orderId} is claimed by another delivery — retrying`);
    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: String(orderId), response: "Retry: another delivery holds this order", status: 409 });
    throw new Error(`Order ${orderId} is claimed by another delivery — retrying`);
  }

  try {
    await createInvoiceForOrder(env, config, webhookId, order, appStorage);
  } finally {
    // Release as soon as the outcome is durable in processed_orders. This is a
    // lock held for seconds, never a second source of truth.
    await appStorage.releaseOrderClaim(String(orderId));
  }
}

/**
 * Everything `handleOrderCreated` does once it holds the order's claim. Split
 * out only so the claim has an honest `finally` around exactly the work it
 * protects — the body is unchanged.
 */
async function createInvoiceForOrder(
  env: Env,
  config: IRequestConfig,
  webhookId: string | null,
  order: any,
  appStorage: AppStorage,
) {
  const webhookTopic = "orders/created";
  const orderId = order.id;

  // Zero-amount short-circuit. For retail these are gift cards and test orders
  // and no document is required. Wholesale is different: a 100%-discounted
  // order is a sample or a warranty replacement, real goods leave the building,
  // and the merchant needs a document for it — so shops can opt in via
  // `invoice_zero_total` and get the goods listed at full price with a 100%
  // discount, totalling zero. Off by default.
  const orderTotal = parseFloat(String(order.total_price ?? order.current_total_price ?? "0"));
  const invoiceZero = Number(config.invoice_zero_total) === 1;
  if ((!Number.isFinite(orderTotal) || orderTotal <= 0) && !invoiceZero) {
    console.log(`[Rioko] Skipping zero-amount order ${orderId} (total=${orderTotal})`);
    if (webhookId) {
      await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "success");
    }
    await appStorage.saveLog({
      shopify_domain: config.shopify_domain,
      topic: webhookTopic,
      payload: JSON.stringify({ orderId, total: orderTotal }),
      response: "Skipped: zero-amount order — no invoice required",
      status: 200,
    });
    return;
  }

  // Payment gate (opt-in per shop via only_invoice_when_paid). Hold emission for
  // any order Shopify hasn't confirmed as paid — Multibanco "pending",
  // bank-transfer "authorized", etc. Issuing a legal invoice for money that may
  // never arrive is fiscally wrong. When the payment confirms, the orders/paid
  // webhook re-runs THIS create flow (self-heal) with a paid order, so the
  // invoice is emitted then — and finalized in the same cycle if auto_finalize
  // is on. Orthogonal to auto_finalize: this gates whether an invoice is created
  // at all. POS/ticket-office orders are "paid" at creation, so unaffected.
  if (config.only_invoice_when_paid === 1 && String(order.financial_status) !== "paid") {
    console.log(`[Rioko] Order ${orderId} held — financial_status=${order.financial_status} (only_invoice_when_paid on)`);
    if (webhookId) {
      await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "success");
    }
    await appStorage.saveLog({
      shopify_domain: config.shopify_domain,
      topic: webhookTopic,
      payload: JSON.stringify({ orderId, financial_status: order.financial_status ?? null }),
      response: "Held: payment pending — invoice suspended until Shopify confirms payment",
      status: 200,
    });
    return;
  }

  const ixRef = `Order #${order.order_number}`;
  const ixHeaders = {
    "x-account-name": config.ix_account_name!,
    "x-api-key": config.ix_api_key!,
    "x-env": config.ix_environment === "production" ? "prod" as const : "dev" as const,
  };
  // Check if invoice already exists in InvoiceXpress system
  const ixExisting = await IxApi.v2.documents.reference.post({
    headers: ixHeaders,
    body: {
      reference: ixRef,
    },
  });

  if (ixExisting.data?.data?.id) {
    console.log(`[Rioko] Invoice already exists for order ${orderId}`);
    // Persist the mapping. Without this, orders/paid can never find the invoice
    // (the IX doc exists but processed_orders has no row) and retries forever
    // with "Invoice not found by order.id".
    await appStorage.saveProcessedInvoice(orderId, String(ixExisting.data.data.id));
    if (webhookId) {
      await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "success");
    }
    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: JSON.stringify({ orderId, invoiceId: ixExisting.data.data.id }), response: "Already exists — linked", status: 200 });
    return;
  }

  const shopify = new Shopify(env.NORMALIZE_SHOPIFY_ORDER_API_KEY, config);
  const normalizedOrderResponse = env.NORMALIZE_IN_WORKER === "1"
    ? await shopify.normalizeOrderLocal(orderId)
    : await shopify.normalizeOrder(orderId);

  if (!normalizedOrderResponse) {
    console.log(`[Rioko] Failed to normalize order for order ${orderId}`);
    throw new Error(`Failed to normalize order for order ${orderId}`);
  }

  console.log(normalizedOrderResponse);

  const viesChecker = config.b2b_reverse_charge === 1 ? makeViesChecker(env.INVOICE_KV) : undefined;
  const productOverrides = config.user_id
    ? await loadProductOverrides(env, config.user_id, "shopify", "invoicexpress")
    : undefined;
  const ixBuilder = new IxBuilder(config, viesChecker, productOverrides);

  const build = await ixBuilder.createInvoiceFromNormalizedOrderAsync(normalizedOrderResponse.normalized);

  if (build.status === "deferred") {
    // VIES couldn't confirm in time. Queue for retry; do NOT create an invoice
    // yet. The 15-min cron will pick this up.
    const nextRetryAt = new Date(Date.now() + 15 * 60_000).toISOString();
    await appStorage.enqueuePendingReverseCharge({
      shopify_domain: config.shopify_domain ?? null,
      user_id: config.user_id,
      order_id: String(orderId),
      vat_id: build.vatNumber,
      country_code: build.countryCode,
      normalized_json: JSON.stringify(normalizedOrderResponse.normalized),
      webhook_topic: webhookTopic,
      webhook_id: webhookId,
      next_retry_at: nextRetryAt,
    });
    if (webhookId) {
      await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "success");
    }
    await appStorage.saveLog({
      shopify_domain: config.shopify_domain,
      topic: webhookTopic,
      payload: JSON.stringify({ orderId, vat: `${build.countryCode}${build.vatNumber}` }),
      response: "Deferred: VIES retry queued",
      status: 202,
    });
    console.log(`[Rioko] Order ${orderId} deferred for VIES retry (vat=${build.countryCode}${build.vatNumber})`);
    return;
  }

  const { invoice, reverseCharge, nifHold } = build;

  console.log(`[Rioko] Built follwoing invoice (reverseCharge=${reverseCharge})`);
  console.log(invoice);

  const { res: ixCreateResponse, via } = await createIxInvoiceWithFallback(
    ixHeaders,
    invoice,
    config.ix_document_type === "invoice_receipt" ? "invoice_receipt" : "invoice",
    { forceTaxRate: config.force_tax_rate, forceShippingTaxRate: config.force_shipping_tax_rate },
  );

  if (ixCreateResponse.data?.data?.id) {
    const invoiceId = String(ixCreateResponse.data.data.id);
    console.log(`[Rioko] Invoice created for order ${orderId}${via !== "none" ? ` (via ${via} fallback)` : ""}`);

    // Save processed invoice to database. A `hold_reason` parks the document as
    // a draft: orders/paid will skip finalize and the customer email, and the
    // merchant gets the notice below. A clean build writes NULL, which is also
    // what clears a hold on re-emit.
    await appStorage.saveProcessedInvoice(orderId, invoiceId, {
      holdReason: nifHold ? nifHoldReason(nifHold) : null,
    });

    if (nifHold) {
      await notifyNifHold(env, config, order, invoiceId, nifHold);
    }

    // Mark webhook as processed
    if (webhookId) {
      await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "success");
    }

    await appStorage.saveLog({
      shopify_domain: config.shopify_domain, topic: webhookTopic, payload: JSON.stringify({
        orderId,
        invoice: ixCreateResponse.data?.data
      }), response: nifHold ? `Created (draft — ${nifHoldReason(nifHold)})` : "Created", status: 200
    });
  } else {
    // The IX rejection reason (tax not found, fiscal invalid, plan limit, …)
    // used to go ONLY to console.log — ephemeral in Workers — so the DB log and
    // the incident kept the useless generic "Failed to create invoice". Diagnosing
    // a 26-order outage then needed a live re-emit. Persist the real reason: write
    // it to the log row AND embed it in the thrown Error so the queue consumer's
    // own error log / incident carries it too.
    const ixError = JSON.stringify(ixCreateResponse.error ?? ixCreateResponse.data ?? null).slice(0, 1500);
    console.log(`[Rioko] Failed to create invoice for order ${orderId}: ${ixError}`);

    // If the failure is the IX plan's document-quota limit, alert the merchant
    // (deduped per account+period) so they can upgrade and unblock invoicing.
    await maybeSendQuotaReachedAlert(env, config, ixError);

    await appStorage.saveLog({
      shopify_domain: config.shopify_domain,
      topic: webhookTopic,
      payload: JSON.stringify({ orderId }),
      response: `IX create failed: ${ixError}`,
      status: 500,
    });

    // Mark webhook as failed
    if (webhookId) {
      await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "failed");
    }

    throw new Error(`Failed to create invoice for order ${orderId}: ${ixError}`);
  }
}
