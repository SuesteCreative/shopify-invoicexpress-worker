import type { Env } from "../env";
import type { IRequestConfig } from "../storage";
import { AppStorage } from "../storage";
import { Shopify } from "../shopify";
import { IxApi } from "../api/ix";
import { IxBuilder, nifHoldReason } from "../ix/builder";
import { createIxInvoiceWithFallback, ixExpectedTotals } from "../ix/create-invoice";
import { sendDevModeEmail } from "./notify";
import { sendIxDocumentEmail, describeIxEmailOutcome } from "../services/ix-document-email";
import { saleReference, cancelReference } from "../services/document-references";
import { fetchShopifyOrders, fetchOrdersByIds, shopifyOrderNotFoundHint } from "../services/shopify-orders";
import { parseIxDate, formatPtDate, todayUtcYmd } from "../ix/date";
import { resolveExemptionCode } from "../ix/exemption";
// The IX-specific finalize machinery lives with the IX adapter now; these were
// duplicated here and in admin-stripe.ts, and the copies had already drifted.
import {
  buildIxDatePutBody, fetchAccountTaxes, fetchSeriesLastFinalizedDate,
  isAlreadyFinalizedIxError, isDateRejectionIxError,
} from "../adapters/destinations/ix-finalize";
import { logDocumentEvent, explainPlatformError } from "../services/document-log";

interface ShopifyOrderSummary {
  id: number;
  order_number: number;
  name: string;
  created_at: string;
  financial_status: string;
  fulfillment_status: string | null;
  total_price: string;
  customer_name: string | null;
  customer_email: string | null;
  note: string | null;
}

type OrderResult = {
  order_id: number;
  order_number: number;
  status: "created" | "finalized" | "skipped" | "error" | "dry_run";
  message: string;
  /** YYYY-MM-DD the document was actually issued with; feeds the series baseline. */
  finalized_date?: string;
};

export interface ProcessOrdersOptions {
  dry_run?: boolean;
  since_last_processed?: boolean;
  notify_emails?: string[];
  triggered_by?: string | null;
  reason?: string | null;
  /** Explicit-id path only: keep only financial_status=paid orders. Auto-heal
   *  must never invoice an order that has since been refunded/cancelled. */
  paid_only?: boolean;
}

function summarizeOrder(order: any): ShopifyOrderSummary {
  return {
    id: order.id,
    order_number: order.order_number,
    name: order.name,
    created_at: order.created_at,
    financial_status: order.financial_status,
    fulfillment_status: order.fulfillment_status,
    total_price: order.total_price,
    customer_name: order.customer
      ? `${order.customer.first_name ?? ""} ${order.customer.last_name ?? ""}`.trim() || null
      : null,
    customer_email: order.customer?.email ?? null,
    note: order.note,
  };
}

/**
 * "Does an invoice with this reference already exist in InvoiceXpress?" — the
 * dedup leg that protects PHANTOM orders (present in IX, absent from our D1),
 * where our DB check can't help. The lookup rides ix-proxy, which under load
 * intermittently answers "not found" for invoices that DO exist (the
 * phantom-"Sem fatura" failure). A single false "not found" here would let us
 * create a DUPLICATE invoice — unacceptable for fiscal documents. So we retry a
 * null a few times with backoff: a transient blip resolves, a genuine absence
 * stays null across every attempt. Returns the existing invoice id, or null
 * only after the retries agree it's absent.
 */
async function findIxInvoiceByReference(
  ixHeaders: { "x-account-name": string; "x-api-key": string; "x-env": "prod" | "dev" },
  reference: string,
  attempts = 2,
): Promise<string | null> {
  let lastErr: unknown = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await IxApi.v2.documents.reference.post({ headers: ixHeaders, body: { reference } });
      const id = res.data?.data?.id;
      if (id) return String(id);
    } catch (e) {
      lastErr = e;
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, 300));
  }
  if (lastErr) console.warn(`[Rioko] IX reference lookup errored ${attempts}x for "${reference}": ${String((lastErr as any)?.message ?? lastErr).slice(0, 120)}`);
  return null;
}


export async function getUnprocessedOrders(env: Env, config: IRequestConfig, from: string, to: string) {
  const appStorage = new AppStorage(env, config.shopify_domain!);

  const shopifyOrders = await fetchShopifyOrders(config, from, to);
  const orderIds = shopifyOrders.map((o) => String(o.id));
  const processedIds = await appStorage.getProcessedOrderIds(orderIds);

  const notInDb = shopifyOrders.filter((o) => !processedIds.has(String(o.id)));

  // Also check InvoiceXpress by reference to filter out orders that exist there but not in our DB
  const ixHeaders = {
    "x-account-name": config.ix_account_name!,
    "x-api-key": config.ix_api_key!,
    "x-env": config.ix_environment === "production" ? "prod" as const : "dev" as const,
  };

  const unprocessed: any[] = [];
  const existsInIx: any[] = [];

  for (const order of notInDb) {
    const ixRef = saleReference(order.order_number);
    const existingId = await findIxInvoiceByReference(ixHeaders, ixRef);

    if (existingId) {
      // Exists in IX but not in our DB — sync it
      await appStorage.saveProcessedInvoice(String(order.id), existingId);
      existsInIx.push(order);
    } else {
      unprocessed.push(order);
    }
  }

  return {
    total_shopify_orders: shopifyOrders.length,
    processed_count: processedIds.size,
    exists_in_ix_synced: existsInIx.length,
    unprocessed_count: unprocessed.length,
    unprocessed: unprocessed.map(summarizeOrder),
  };
}

export async function processOrders(
  env: Env,
  config: IRequestConfig,
  type: "create_orders" | "finalize_orders",
  orderIds: number[] | undefined,
  from?: string,
  to?: string,
  options: ProcessOrdersOptions = {}
) {
  const appStorage = new AppStorage(env, config.shopify_domain!);
  const dryRun = !!options.dry_run;

  let orders: any[];
  let effectiveFrom = from;
  let effectiveTo = to;

  if (orderIds && orderIds.length > 0) {
    orders = await fetchOrdersByIds(config, orderIds);
    if (options.paid_only && type === "create_orders") {
      orders = orders.filter((o) => o.financial_status === "paid");
    }
  } else {
    if (options.since_last_processed) {
      const last = await appStorage.getLastProcessedDate();
      effectiveFrom = last ?? (effectiveFrom ?? "2020-01-01T00:00:00Z");
      effectiveTo = effectiveTo ?? new Date().toISOString();
    }
    if (!effectiveFrom || !effectiveTo) {
      throw new Error("Either order_ids or from/to date range (or since_last_processed) is required");
    }
    const shopifyOrders = await fetchShopifyOrders(config, effectiveFrom, effectiveTo);
    // Hard rule: only paid orders are eligible for invoice creation
    const paidOrders = type === "create_orders"
      ? shopifyOrders.filter((o) => o.financial_status === "paid")
      : shopifyOrders;
    const allIds = paidOrders.map((o) => String(o.id));
    const processedIds = await appStorage.getProcessedOrderIds(allIds);

    if (type === "create_orders") {
      orders = paidOrders.filter((o) => !processedIds.has(String(o.id)));
    } else {
      orders = paidOrders.filter((o) => processedIds.has(String(o.id)));
    }
  }

  const jobId = crypto.randomUUID();
  await appStorage.startDevJob({
    id: jobId,
    type: dryRun ? `${type}_dry_run` : type,
    params: { orderIds, from: effectiveFrom, to: effectiveTo, options },
    triggered_by: options.triggered_by ?? null,
    reason: options.reason ?? null,
  });

  const results: OrderResult[] = [];

  // Finalize OLDEST FIRST, and read the series' last issued date once for the
  // whole batch. IX refuses a document dated before the last one in its series,
  // so working newest-first would push the baseline past every older draft and
  // force them all onto today's date; going forward in time lets each document
  // keep the day its sale actually happened. The baseline is also advanced
  // locally after each success, so the next document aims at a date IX will
  // take instead of burning a rejected attempt.
  let seriesLastFinalizedDate: string | null = null;
  if (!dryRun && type === "finalize_orders") {
    orders = [...orders].sort((a, b) =>
      String(a.processed_at ?? a.created_at ?? "").localeCompare(String(b.processed_at ?? b.created_at ?? "")));
    seriesLastFinalizedDate = await fetchSeriesLastFinalizedDate(
      config,
      config.ix_document_type === "invoice_receipt" ? "invoice_receipt" : "invoice",
    );
  }

  for (const order of orders) {
    if (dryRun) {
      results.push(await adminDryRunCreate(env, config, order, type));
    } else if (type === "create_orders") {
      results.push(await adminCreateOrder(env, config, order));
    } else {
      const r = await adminFinalizeOrder(env, config, order, seriesLastFinalizedDate);
      if (r.finalized_date && (!seriesLastFinalizedDate || r.finalized_date > seriesLastFinalizedDate)) {
        seriesLastFinalizedDate = r.finalized_date;
      }
      results.push(r);
    }
  }

  const summary = {
    type,
    dry_run: dryRun,
    total: results.length,
    success: results.filter((r) => r.status === "created" || r.status === "finalized").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    errors: results.filter((r) => r.status === "error").length,
    would_create: results.filter((r) => r.status === "dry_run").length,
    from: effectiveFrom,
    to: effectiveTo,
  };

  const status: "success" | "partial" | "error" = summary.errors === 0
    ? "success"
    : summary.success > 0 || summary.would_create > 0 ? "partial" : "error";

  await appStorage.finishDevJob(jobId, status, summary, results);

  if (options.notify_emails && options.notify_emails.length > 0) {
    const subject = `Rioko Dev Mode — ${type}${dryRun ? " (dry-run)" : ""} for ${config.shopify_domain}`;
    const body = [
      `Job: ${type}${dryRun ? " (dry-run)" : ""}`,
      `Shop: ${config.shopify_domain}`,
      `Triggered by: ${options.triggered_by ?? "unknown"}`,
      `Reason: ${options.reason ?? "—"}`,
      `From: ${effectiveFrom ?? "—"}  To: ${effectiveTo ?? "—"}`,
      ``,
      `Total: ${summary.total}`,
      `Success: ${summary.success}`,
      `Skipped: ${summary.skipped}`,
      `Errors: ${summary.errors}`,
      dryRun ? `Would create: ${summary.would_create}` : ``,
      ``,
      `Job ID: ${jobId}`,
    ].filter(Boolean).join("\n");
    await sendDevModeEmail({ recipients: options.notify_emails, subject, body });
  }

  return { job_id: jobId, ...summary, results };
}

async function adminDryRunCreate(env: Env, config: IRequestConfig, order: any, type: "create_orders" | "finalize_orders"): Promise<OrderResult> {
  const appStorage = new AppStorage(env, config.shopify_domain!);
  const orderId = String(order.id);

  try {
    if (type === "finalize_orders") {
      const ref = await appStorage.getInvoiceByOrderId(orderId);
      return ref
        ? { order_id: order.id, order_number: order.order_number, status: "dry_run", message: `Would finalize invoice ${ref.invoice_id}` }
        : { order_id: order.id, order_number: order.order_number, status: "skipped", message: "No invoice on file" };
    }

    const already = await appStorage.isInvoiceAlreadyProcessed(orderId);
    if (already) return { order_id: order.id, order_number: order.order_number, status: "skipped", message: "Already in DB" };

    const ixHeaders = {
      "x-account-name": config.ix_account_name!,
      "x-api-key": config.ix_api_key!,
      "x-env": config.ix_environment === "production" ? "prod" as const : "dev" as const,
    };
    const existingId = await findIxInvoiceByReference(ixHeaders, saleReference(order.order_number));
    if (existingId) {
      return { order_id: order.id, order_number: order.order_number, status: "skipped", message: `Exists in IX (id=${existingId})` };
    }
    return { order_id: order.id, order_number: order.order_number, status: "dry_run", message: "Would create invoice" };
  } catch (e) {
    return { order_id: order.id, order_number: order.order_number, status: "error", message: String(e) };
  }
}

export async function reemitOrder(
  env: Env,
  config: IRequestConfig,
  orderNumber: number,
  options: { force?: boolean; reason?: string | null; triggered_by?: string | null; notify_emails?: string[] }
) {
  const appStorage = new AppStorage(env, config.shopify_domain!);
  const jobId = crypto.randomUUID();
  await appStorage.startDevJob({
    id: jobId,
    type: "reemit",
    params: { order_number: orderNumber, force: !!options.force },
    triggered_by: options.triggered_by ?? null,
    reason: options.reason ?? null,
  });

  const apiVersion = config.shopify_api_version ?? "2026-01";
  const url = `https://${config.shopify_domain}/admin/api/${apiVersion}/orders.json?name=${encodeURIComponent("#" + orderNumber)}&status=any&limit=1`;
  let order: any = null;

  try {
    const res = await fetch(url, {
      headers: { "X-Shopify-Access-Token": config.shopify_token!, "Accept": "application/json" },
    });
    if (!res.ok) throw new Error(`Shopify ${res.status}: ${await res.text()}`);
    const data = await res.json() as { orders: any[] };
    order = data.orders?.[0];
  } catch (e) {
    const summary = { error: String(e) };
    await appStorage.finishDevJob(jobId, "error", summary, []);
    return { job_id: jobId, status: "error", ...summary };
  }

  if (!order) {
    const summary = { error: shopifyOrderNotFoundHint(orderNumber) };
    await appStorage.finishDevJob(jobId, "error", summary, []);
    return { job_id: jobId, status: "error", ...summary };
  }

  if (order.financial_status !== "paid") {
    const summary = { error: `Order #${orderNumber} is not paid (financial_status=${order.financial_status})` };
    await appStorage.finishDevJob(jobId, "error", summary, []);
    return { job_id: jobId, status: "error", ...summary };
  }

  // Force re-emit used to unlink the DB row and create a fresh document while
  // leaving the previous one behind in InvoiceXpress — an orphan the merchant
  // then found in their drafts with no idea what it was, and which the "por
  // emitir" reporting could not account for. Clean it up first.
  //
  // Only ever a DRAFT. A finalized document is a certified fiscal record: it is
  // corrected with a credit note, never deleted, so we leave it and say so.
  let discarded: string | null = null;
  let keptFinalized: string | null = null;
  if (options.force) {
    const existing = await appStorage.getInvoiceByOrderId(String(order.id));
    if (existing?.invoice_id) {
      const outcome = await discardIxDraft(config, existing.invoice_id);
      if (outcome === "deleted") discarded = existing.invoice_id;
      else if (outcome === "finalized") keptFinalized = existing.invoice_id;
    }
    await appStorage.deleteProcessedInvoice(String(order.id));
  }

  const result = await adminCreateOrder(env, config, order, { skipIxReferenceCheck: !!options.force });
  const status: "success" | "error" = result.status === "created" ? "success" : "error";
  if (discarded) result.message = `${result.message} (rascunho anterior ${discarded} apagado)`;
  if (keptFinalized) result.message = `${result.message} (ATENÇÃO: ${keptFinalized} já estava finalizado e foi mantido — emita nota de crédito se for duplicado)`;
  const summary = { result, force: !!options.force, discarded_draft: discarded, kept_finalized: keptFinalized };
  await appStorage.finishDevJob(jobId, status === "success" ? "success" : "partial", summary, [result]);

  if (options.notify_emails && options.notify_emails.length > 0) {
    await sendDevModeEmail({
      recipients: options.notify_emails,
      subject: `Rioko Dev Mode — Re-emit ${order.name} for ${config.shopify_domain}`,
      body: `Order: ${order.name}\nStatus: ${result.status}\nMessage: ${result.message}\nForce: ${options.force ? "yes" : "no"}\nReason: ${options.reason ?? "—"}\nJob ID: ${jobId}`,
    });
  }

  return { job_id: jobId, ...result };
}

async function lookupOrderAndInvoice(
  env: Env,
  config: IRequestConfig,
  orderNumber: number
): Promise<{ order: any | null; invoiceId: string | null; ixInvoice: any | null; error?: string }> {
  const appStorage = new AppStorage(env, config.shopify_domain!);
  const apiVersion = config.shopify_api_version ?? "2026-01";
  const url = `https://${config.shopify_domain}/admin/api/${apiVersion}/orders.json?name=${encodeURIComponent("#" + orderNumber)}&status=any&limit=1`;

  const res = await fetch(url, { headers: { "X-Shopify-Access-Token": config.shopify_token!, "Accept": "application/json" } });
  if (!res.ok) return { order: null, invoiceId: null, ixInvoice: null, error: `Shopify ${res.status}: ${await res.text()}` };
  const data = await res.json() as { orders: any[] };
  const order = data.orders?.[0];
  if (!order) return { order: null, invoiceId: null, ixInvoice: null, error: `Order #${orderNumber} not found in Shopify. If the order exists, the access token is likely missing the read_all_orders scope (Admin API hides orders older than 60 days without it).` };

  const invoiceRef = await appStorage.getInvoiceByOrderId(String(order.id));
  if (!invoiceRef) return { order, invoiceId: null, ixInvoice: null, error: `No invoice registered for order ${order.id}` };

  const ixHeaders = {
    "x-account-name": config.ix_account_name!,
    "x-api-key": config.ix_api_key!,
    "x-env": config.ix_environment === "production" ? "prod" as const : "dev" as const,
  };
  const { data: ixData, error: ixErr } = await IxApi.v2.documents.byId.get({
    headers: ixHeaders, path: { id: Number(invoiceRef.invoice_id) },
  });
  if (ixErr || !ixData?.data) return { order, invoiceId: invoiceRef.invoice_id, ixInvoice: null, error: `IX fetch failed: ${JSON.stringify(ixErr)}` };
  return { order, invoiceId: invoiceRef.invoice_id, ixInvoice: ixData.data };
}

export async function deleteDraftByOrderNumber(
  env: Env,
  config: IRequestConfig,
  orderNumber: number,
  options: { reason?: string | null; triggered_by?: string | null; notify_emails?: string[] }
) {
  const appStorage = new AppStorage(env, config.shopify_domain!);
  const jobId = crypto.randomUUID();
  await appStorage.startDevJob({
    id: jobId, type: "delete_draft", params: { order_number: orderNumber },
    triggered_by: options.triggered_by ?? null, reason: options.reason ?? null,
  });

  const lookup = await lookupOrderAndInvoice(env, config, orderNumber);
  if (lookup.error) {
    await appStorage.finishDevJob(jobId, "error", { error: lookup.error }, []);
    return { job_id: jobId, status: "error", error: lookup.error };
  }
  const state = (lookup.ixInvoice as any).status ?? (lookup.ixInvoice as any).state;
  if (state === "deleted") {
    await appStorage.deleteProcessedInvoice(String(lookup.order.id));
    const summary = { invoice_id: lookup.invoiceId, order_id: lookup.order.id, order_number: orderNumber, message: `Invoice already deleted in InvoiceXpress — removed stale DB link so order can be re-emitted.` };
    await appStorage.finishDevJob(jobId, "success", summary, [summary]);
    return { job_id: jobId, status: "success", ...summary };
  }
  if (state !== "draft") {
    const err = `Invoice ${lookup.invoiceId} is not draft (status=${state}). Use issue-credit-note for finalized invoices.`;
    await appStorage.finishDevJob(jobId, "error", { error: err }, []);
    return { job_id: jobId, status: "error", error: err };
  }

  const ixHeaders = {
    "x-account-name": config.ix_account_name!,
    "x-api-key": config.ix_api_key!,
    "x-env": config.ix_environment === "production" ? "prod" as const : "dev" as const,
  };
  const { error } = await IxApi.v2.changeState.post({
    body: {
      type: config.ix_document_type === "invoice_receipt" ? "invoice_receipt" : "invoice",
      id: Number(lookup.invoiceId),
      state: "deleted",
    },
    headers: ixHeaders,
  });
  if (error) {
    const err = `IX delete failed: ${JSON.stringify(error)}`;
    await appStorage.finishDevJob(jobId, "error", { error: err }, []);
    return { job_id: jobId, status: "error", error: err };
  }

  await appStorage.deleteProcessedInvoice(String(lookup.order.id));
  const summary = { invoice_id: lookup.invoiceId, order_id: lookup.order.id, order_number: orderNumber };
  await appStorage.finishDevJob(jobId, "success", summary, [summary]);

  if (options.notify_emails && options.notify_emails.length > 0) {
    await sendDevModeEmail({
      recipients: options.notify_emails,
      subject: `Rioko Dev Mode — Draft eliminado #${orderNumber} (${config.shopify_domain})`,
      body: `Invoice ${lookup.invoiceId} eliminado.\nReason: ${options.reason ?? "—"}\nTriggered by: ${options.triggered_by ?? "—"}\nJob ID: ${jobId}`,
    });
  }

  return { job_id: jobId, status: "success", ...summary };
}

export async function issueCreditNoteByOrderNumber(
  env: Env,
  config: IRequestConfig,
  orderNumber: number,
  options: { reason?: string | null; triggered_by?: string | null; notify_emails?: string[] }
) {
  const appStorage = new AppStorage(env, config.shopify_domain!);
  const jobId = crypto.randomUUID();
  await appStorage.startDevJob({
    id: jobId, type: "issue_credit_note", params: { order_number: orderNumber },
    triggered_by: options.triggered_by ?? null, reason: options.reason ?? null,
  });

  const lookup = await lookupOrderAndInvoice(env, config, orderNumber);
  if (lookup.error) {
    await appStorage.finishDevJob(jobId, "error", { error: lookup.error }, []);
    return { job_id: jobId, status: "error", error: lookup.error };
  }
  const state = (lookup.ixInvoice as any).status ?? (lookup.ixInvoice as any).state;
  if (state === "draft") {
    const err = `Invoice ${lookup.invoiceId} is still draft. Use delete-draft instead.`;
    await appStorage.finishDevJob(jobId, "error", { error: err }, []);
    return { job_id: jobId, status: "error", error: err };
  }

  const ixHeaders = {
    "x-account-name": config.ix_account_name!,
    "x-api-key": config.ix_api_key!,
    "x-env": config.ix_environment === "production" ? "prod" as const : "dev" as const,
  };

  // Idempotency: check existing CNs for this invoice
  const { data: rel } = await IxApi.v2.documents.byId.related.get({
    headers: ixHeaders, path: { id: Number(lookup.invoiceId) },
  });
  const reference = cancelReference("shopify", orderNumber);
  const existing = (rel?.data?.documents ?? []).find((d: any) => d.type === "CreditNote" && d.reference === reference);
  if (existing) {
    const summary = { invoice_id: lookup.invoiceId, credit_note_id: existing.id, message: "Credit note already exists, skipped" };
    await appStorage.finishDevJob(jobId, "success", summary, [summary]);
    return { job_id: jobId, status: "success", ...summary };
  }

  // Build CN from normalized order
  const shopify = new Shopify(env.NORMALIZE_SHOPIFY_ORDER_API_KEY, config);
  const normalized = await shopify.normalizeOrder(String(lookup.order.id));
  if (!normalized) {
    const err = "Failed to normalize order";
    await appStorage.finishDevJob(jobId, "error", { error: err }, []);
    return { job_id: jobId, status: "error", error: err };
  }

  const ixBuilder = new IxBuilder(config);
  const { invoice: built } = ixBuilder.createInvoiceFromNormalizedOrder(normalized.normalized);
  const items = built.items;
  const requireTaxExemption = items.some((it: any) =>
    typeof it.tax === "number" ? it.tax === 0 : it.tax.value === 0
  );
  const creditNote: any = {
    ...built,
    reference,
    tax_exemption_reason: requireTaxExemption
      ? resolveExemptionCode((lookup.ixInvoice as any)?.tax_exemption, config.ix_exemption_reason) ?? undefined
      : undefined,
    owner_invoice_id: Number(lookup.invoiceId),
  };

  const { data: cnResp, error: cnErr } = await IxApi.v2.creditNotes.post({
    headers: ixHeaders,
    body: { credit_note: creditNote },
    query: { resolvers: "on_tax_fallback_search_tax_by_value" },
  });
  if (cnErr) {
    const err = `IX credit note create failed: ${JSON.stringify(cnErr)}`;
    await appStorage.finishDevJob(jobId, "error", { error: err }, []);
    return { job_id: jobId, status: "error", error: err };
  }

  const cnId = (cnResp?.data as any)?.id
    ?? (cnResp?.data as any)?.credit_note?.id
    ?? (cnResp?.data as any)?.creditNote?.id;

  if (cnId) {
    await IxApi.v2.changeState.post({
      body: { type: "credit_note", id: cnId, state: "finalized" },
      headers: ixHeaders,
    });
  }

  const summary = { invoice_id: lookup.invoiceId, credit_note_id: cnId, order_number: orderNumber };
  await appStorage.finishDevJob(jobId, "success", summary, [summary]);

  if (options.notify_emails && options.notify_emails.length > 0) {
    await sendDevModeEmail({
      recipients: options.notify_emails,
      subject: `Rioko Dev Mode — Nota de crédito #${orderNumber} (${config.shopify_domain})`,
      body: `Credit note ${cnId} emitida para invoice ${lookup.invoiceId}.\nReason: ${options.reason ?? "—"}\nTriggered by: ${options.triggered_by ?? "—"}\nJob ID: ${jobId}`,
    });
  }

  return { job_id: jobId, status: "success", ...summary };
}

type DateStrategy = "today" | "closest_available";


/** Note stamped when a document had to be issued later than the sale happened. */
function transactionDateNote(doc: any, originalDate: string): string | null {
  const m = /Order #(\d+)/i.exec(String(doc?.reference ?? ""));
  return m ? `Fatura referente à encomenda #${m[1]} de ${formatPtDate(originalDate)}` : null;
}

export type DraftFinalizeOutcome =
  | { status: "finalized"; date: string; originalDate: string; message: string }
  | { status: "skipped"; message: string }
  | { status: "error"; message: string };

/**
 * Finalize ONE draft, keeping the document as close to the transaction date as
 * InvoiceXpress will accept.
 *
 * Until 2026-08-07 this was a bare `changeState` with `actualizeDateBeforeChange:
 * true`. That flag makes IX push the document's `date` to today while leaving
 * `due_date` on the original order date — and IX then rejects its own result with
 * "Vencimento deve ser igual ou posterior à data do documento". Every draft older
 * than the current day was therefore permanently un-finalizable through this
 * path: five consecutive nightly sweeps finalized nothing while ~275 drafts sat
 * across the fleet, and the noise from `isAlreadyFinalizedIxError` misses (see
 * above) hid it.
 *
 * The date we try, in order of preference:
 *   1. the draft's own date — the day the sale actually happened;
 *   2. the series' most recent finalized date, when that is later, because IX
 *      will not let a finalized document break its series' chronology;
 *   3. today, and only if IX still refuses.
 * Whenever the date moves, `due_date` moves with it and the real transaction
 * date is stamped into the observations, so the document still says what it is
 * for. We escalate ONLY on a date rejection: any other failure leaves the draft
 * untouched rather than silently drifting its date for an unrelated reason.
 */
async function finalizeDraftClosestToDate(
  config: IRequestConfig,
  invoiceId: string,
  ixDocType: "invoice" | "invoice_receipt",
  ixHeaders: { "x-account-name": string; "x-api-key": string; "x-env": "prod" | "dev" },
  opts: {
    seriesLastFinalizedDate?: string | null;
    accountTaxes?: Map<number, { name: string; value: number }>;
    /** What the customer actually paid, when the caller knows it. */
    paidTotal?: number | null;
  } = {},
): Promise<DraftFinalizeOutcome> {
  const { data: docData, error: docError } = await IxApi.v2.documents.byId.get({
    headers: ixHeaders,
    path: { id: Number(invoiceId) },
  });
  if (docError || !docData?.data) {
    return { status: "error", message: `Fetch failed: ${JSON.stringify(docError)}` };
  }
  const doc: any = docData.data;

  // Not a draft = already issued. The sweep re-runs over every processed order
  // in its window, so this is the common case and it is a skip, not an error.
  const state = doc.status ?? doc.state;
  if (state !== "draft") {
    return { status: "skipped", message: `Already finalized (status=${state})` };
  }

  // Finalizing is irreversible: a wrong document can only be undone with a
  // credit note. A draft whose total is not the amount the customer paid is
  // never certified here — it is the 0%-VAT drafts of 2026-08-02→05 (gross
  // 54.72€ on a 58.00€ sale) that this stops, and any future drift too.
  const paid = opts.paidTotal;
  const docTotal = Number(doc.total);
  if (typeof paid === "number" && Number.isFinite(paid) && paid > 0 && Number.isFinite(docTotal)
    && Math.abs(docTotal - paid) > 0.011) {
    return {
      status: "error",
      message: `Total do documento (${docTotal.toFixed(2)}€) não é o valor pago (${paid.toFixed(2)}€) — não certifico`,
    };
  }

  const originalDate = parseIxDate(doc.date);
  if (!originalDate) {
    return { status: "error", message: `Could not parse draft date '${doc.date}'` };
  }

  const seriesLast = opts.seriesLastFinalizedDate !== undefined
    ? opts.seriesLastFinalizedDate
    : await fetchSeriesLastFinalizedDate(config, ixDocType);
  const today = todayUtcYmd();

  // Ascending, de-duplicated, never earlier than the sale itself.
  const candidates = [...new Set(
    [originalDate, seriesLast, today]
      .filter((d): d is string => !!d && d >= originalDate)
      .sort(),
  )];

  const existingObs = typeof doc.observations === "string" ? doc.observations.trim() : "";
  const accountTaxes = opts.accountTaxes ?? await fetchAccountTaxes(ixHeaders);
  let currentDate = originalDate;
  let lastError = "";

  for (const targetDate of candidates) {
    if (targetDate !== currentDate) {
      const note = transactionDateNote(doc, originalDate);
      const observations = note
        ? (existingObs ? `${existingObs} | ${note}` : note).slice(0, 200)
        : existingObs;
      let putBody: any;
      try {
        putBody = buildIxDatePutBody(doc, ixDocType, targetDate, observations, {
          accountTaxes,
          exemptionReason: config.ix_exemption_reason ?? null,
        });
      } catch (e: any) {
        // The rebuild refused (unreadable tax, or a payload that would change
        // the money). Leave the draft exactly as it is.
        return { status: "error", message: String(e?.message ?? e) };
      }
      // Under load the proxy answers a well-formed body with a spurious
      // VALIDATION_ERROR — measured on a backlog run: 81 documents rejected for
      // "Tax name must be at least 1 character" whose lines all carried IVA6,
      // and the very same body accepted first try once the run had stopped. So
      // back off and try again rather than writing off a document.
      let putError: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        ({ error: putError } = await IxApi.v2.documents.byId.put({
          headers: ixHeaders,
          path: { id: Number(invoiceId) },
          body: putBody,
        }));
        if (!putError) break;
      }
      if (putError) {
        return { status: "error", message: `PUT date ${formatPtDate(targetDate)} failed: ${JSON.stringify(putError)}` };
      }
      currentDate = targetDate;
    }

    const { error } = await IxApi.v2.changeState.post({
      headers: ixHeaders,
      body: { type: ixDocType, id: Number(invoiceId), state: "finalized" },
    });
    if (!error) {
      return {
        status: "finalized",
        date: targetDate,
        originalDate,
        message: targetDate === originalDate
          ? `Finalizada com a data da transacção (${formatPtDate(originalDate)})`
          : `Finalizada em ${formatPtDate(targetDate)} — o IX recusou a data da transacção (${formatPtDate(originalDate)}), que ficou anotada no documento`,
      };
    }
    if (isAlreadyFinalizedIxError(error)) {
      return { status: "skipped", message: "Already finalized (document has payments / cannot be edited)" };
    }
    lastError = `Finalize failed: ${JSON.stringify(error)}`;
    // Anything that is not a date complaint will not be fixed by moving the
    // date, so stop here and leave the draft exactly as we found it.
    if (!isDateRejectionIxError(error)) return { status: "error", message: lastError };
  }

  return { status: "error", message: lastError || "Finalize failed: no acceptable date" };
}

export async function finalizeDrafts(
  env: Env,
  config: IRequestConfig,
  options: {
    dry_run?: boolean;
    limit?: number;
    triggered_by?: string | null;
    reason?: string | null;
    notify_emails?: string[];
    date_strategy?: DateStrategy;
    from_order_number?: number | null;
    to_order_number?: number | null;
    from_date?: string | null;
    to_date?: string | null;
  }
) {
  const appStorage = new AppStorage(env, config.shopify_domain!);
  const limit = Math.min(options.limit ?? 100, 500);
  const dryRun = !!options.dry_run;
  const strategy: DateStrategy = options.date_strategy ?? "closest_available";
  const fromOrder = options.from_order_number ?? null;
  const toOrder = options.to_order_number ?? null;
  const fromDate = options.from_date ?? null;
  const toDate = options.to_date ?? null;
  const filterActive = fromOrder != null || toOrder != null || fromDate != null || toDate != null;
  const jobId = crypto.randomUUID();
  await appStorage.startDevJob({
    id: jobId,
    type: dryRun ? "finalize_drafts_dry_run" : "finalize_drafts",
    params: { limit, dry_run: dryRun, date_strategy: strategy, from_order_number: fromOrder, to_order_number: toOrder, from_date: fromDate, to_date: toDate },
    triggered_by: options.triggered_by ?? null,
    reason: options.reason ?? null,
  });

  const ixHeaders = {
    "x-account-name": config.ix_account_name!,
    "x-api-key": config.ix_api_key!,
    "x-env": config.ix_environment === "production" ? "prod" as const : "dev" as const,
  };
  const ixDocType = config.ix_document_type === "invoice_receipt" ? "invoice_receipt" as const : "invoice" as const;
  const today = todayUtcYmd();

  let processed = await appStorage.listProcessedInvoices(limit, "asc");

  // Optional filter by Shopify order_number range or processed_at date range.
  // Resolve order_number + processed_at via one batched Shopify orders.json
  // request and trim `processed` before the heavy IX loop below.
  if (filterActive && processed.length > 0) {
    try {
      const ids = processed.map((r) => Number(r.id)).filter((n) => Number.isFinite(n));
      const raw = await fetchOrdersByIds(config, ids);
      const meta = new Map<string, { order_number: number; processed_at: string | null }>();
      for (const o of raw) {
        if (o?.id != null) {
          meta.set(String(o.id), {
            order_number: Number(o.order_number),
            processed_at: o.processed_at ?? o.created_at ?? null,
          });
        }
      }
      processed = processed.filter((r) => {
        const m = meta.get(r.id);
        if (!m) return false;
        if (fromOrder != null && m.order_number < fromOrder) return false;
        if (toOrder != null && m.order_number > toOrder) return false;
        if (fromDate != null && m.processed_at && m.processed_at < fromDate) return false;
        if (toDate != null && m.processed_at && m.processed_at > toDate) return false;
        return true;
      });
    } catch (e) {
      console.error("[Rioko] finalizeDrafts filter lookup failed:", e);
      await appStorage.finishDevJob(jobId, "error", { error: `Shopify lookup for filter failed: ${String(e)}` }, []);
      return { job_id: jobId, total: 0, finalized: 0, skipped: 0, errors: 1, would_finalize: 0, dry_run: dryRun, date_strategy: strategy, results: [], error: String(e) };
    }
  }
  const results: Array<{ order_id: string; invoice_id: string; status: "finalized" | "dry_run" | "skipped" | "error"; message: string; original_date?: string; target_date?: string }> = [];

  // Pre-fetch the series' last finalized date so closest_available has a real
  // baseline and we don't fall into the "first row uses original → IX rejects
  // every subsequent row" trap that bit SoulKrave's bulk finalize.
  const seriesLastFinalizedDate = strategy === "closest_available"
    ? await fetchSeriesLastFinalizedDate(config, ixDocType)
    : null;
  let lastFinalizedDate: string | null = seriesLastFinalizedDate;

  // The account's tax table, once, for every rebuild in this run.
  const accountTaxes = await fetchAccountTaxes(ixHeaders);

  // What each order actually paid. Certifying a draft that disagrees with it is
  // irreversible, so the amounts are looked up before anything is finalized; a
  // failed lookup leaves the map empty and each row is then judged on the rest.
  const paidByOrderId = new Map<string, number>();
  if (!dryRun && processed.length > 0) {
    try {
      const raw = await fetchOrdersByIds(config, processed.map((r) => Number(r.id)).filter((n) => Number.isFinite(n)));
      for (const o of raw) {
        const total = Number(o?.total_price);
        if (o?.id != null && Number.isFinite(total)) paidByOrderId.set(String(o.id), total);
      }
    } catch (e) {
      console.error("[Rioko] finalizeDrafts paid-total lookup failed:", e);
    }
  }

  for (const row of processed) {
    try {
      // Drafts parked for a human (invalid NIF in the address line) are exactly
      // the drafts a bulk finalize must not touch — the hold exists precisely
      // to stop the document being certified before someone looks at it.
      if (row.hold_reason) {
        results.push({ order_id: row.id, invoice_id: row.invoice_id, status: "skipped", message: `Em rascunho por decisão: ${row.hold_reason}` });
        continue;
      }

      const { data: docData, error: docError } = await IxApi.v2.documents.byId.get({
        headers: ixHeaders,
        path: { id: Number(row.invoice_id) },
      });
      if (docError || !docData?.data) {
        results.push({ order_id: row.id, invoice_id: row.invoice_id, status: "error", message: `Fetch failed: ${JSON.stringify(docError)}` });
        continue;
      }
      const doc: any = docData.data;
      const state = doc.status ?? doc.state;
      if (state !== "draft") {
        results.push({ order_id: row.id, invoice_id: row.invoice_id, status: "skipped", message: `Not draft (status=${state})` });
        continue;
      }

      // Never certify a draft that does not total what the customer paid.
      const paid = paidByOrderId.get(String(row.id));
      const docTotal = Number(doc.total);
      if (paid != null && paid > 0 && Number.isFinite(docTotal) && Math.abs(docTotal - paid) > 0.011) {
        results.push({
          order_id: row.id, invoice_id: row.invoice_id, status: "error",
          message: `Total do documento (${docTotal.toFixed(2)}€) não é o valor pago (${paid.toFixed(2)}€) — não certifico`,
        });
        continue;
      }

      const originalDate = parseIxDate(doc.date);
      if (!originalDate) {
        results.push({ order_id: row.id, invoice_id: row.invoice_id, status: "error", message: `Could not parse draft date '${doc.date}'` });
        continue;
      }

      let targetDate: string;
      if (strategy === "today") {
        targetDate = today;
      } else {
        // closest_available: prefer the draft's own date. Only bump when the
        // IX series already has a finalized invoice with a more recent date
        // (running last-finalized within the loop OR the series's pre-fetched
        // baseline). NEVER clamp to today silently — if user wants today they
        // pick `today` strategy. If IX still rejects (rare race), the per-row
        // error is reported and the loop continues without advancing.
        targetDate = originalDate;
        if (lastFinalizedDate && lastFinalizedDate > targetDate) targetDate = lastFinalizedDate;
      }

      const dateChanged = targetDate !== originalDate;
      const orderNumberMatch = /Order #(\d+)/i.exec(String(doc.reference ?? ""));
      const orderNumber = orderNumberMatch ? orderNumberMatch[1] : null;
      const appendNote = dateChanged && orderNumber
        ? `Fatura referente à encomenda #${orderNumber} de ${formatPtDate(originalDate)}`
        : null;
      const existingObs = typeof doc.observations === "string" ? doc.observations.trim() : "";
      const newObservations = appendNote
        ? (existingObs ? `${existingObs} | ${appendNote}` : appendNote).slice(0, 200)
        : existingObs;

      if (dryRun) {
        results.push({
          order_id: row.id,
          invoice_id: row.invoice_id,
          status: "dry_run",
          message: dateChanged
            ? `Would PUT date ${formatPtDate(originalDate)} → ${formatPtDate(targetDate)} and append: "${appendNote}", then finalize`
            : `Would finalize as-is (${formatPtDate(originalDate)})`,
          original_date: originalDate,
          target_date: targetDate,
        });
        lastFinalizedDate = targetDate;
        continue;
      }

      if (dateChanged) {
        let putBody: any;
        try {
          putBody = buildIxDatePutBody(doc, ixDocType, targetDate, newObservations, {
            accountTaxes,
            exemptionReason: config.ix_exemption_reason ?? null,
          });
        } catch (e: any) {
          results.push({ order_id: row.id, invoice_id: row.invoice_id, status: "error", message: String(e?.message ?? e), original_date: originalDate, target_date: targetDate });
          continue;
        }
        const { error: putError } = await IxApi.v2.documents.byId.put({
          headers: ixHeaders,
          path: { id: Number(row.invoice_id) },
          body: putBody,
        });
        if (putError) {
          results.push({ order_id: row.id, invoice_id: row.invoice_id, status: "error", message: `PUT date failed: ${JSON.stringify(putError)}`, original_date: originalDate, target_date: targetDate });
          continue;
        }
      }

      const { error } = await IxApi.v2.changeState.post({
        body: {
          type: ixDocType,
          id: Number(row.invoice_id),
          state: "finalized",
        },
        headers: ixHeaders,
      });
      if (error) {
        results.push({ order_id: row.id, invoice_id: row.invoice_id, status: "error", message: JSON.stringify(error), original_date: originalDate, target_date: targetDate });
      } else {
        lastFinalizedDate = targetDate;
        results.push({
          order_id: row.id,
          invoice_id: row.invoice_id,
          status: "finalized",
          message: dateChanged
            ? `Finalized with date ${formatPtDate(targetDate)} (original ${formatPtDate(originalDate)})`
            : `Finalized as-is (${formatPtDate(targetDate)})`,
          original_date: originalDate,
          target_date: targetDate,
        });
      }
    } catch (e) {
      results.push({ order_id: row.id, invoice_id: row.invoice_id, status: "error", message: String(e) });
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
      subject: `Rioko Dev Mode — Finalize drafts${dryRun ? " (dry-run)" : ""} for ${config.shopify_domain}`,
      body: `Total: ${summary.total}\nStrategy: ${strategy}\nFinalized: ${summary.finalized}\nSkipped: ${summary.skipped}\nErrors: ${summary.errors}${dryRun ? `\nWould finalize: ${summary.would_finalize}` : ""}\nJob ID: ${jobId}`,
    });
  }

  return { job_id: jobId, ...summary, results };
}

/**
 * Delete an InvoiceXpress document, but only while it is still a draft.
 *
 * Returns what happened so the caller can report it:
 *   "deleted"   — it was a draft and is now gone
 *   "finalized" — a certified document; left untouched, needs a credit note
 *   "gone"      — already deleted, or IX could not be reached
 *
 * Never throws: this runs as cleanup alongside an operation whose real work is
 * creating the replacement, and failing that because a tidy-up failed would be
 * the wrong trade.
 */
async function discardIxDraft(config: IRequestConfig, invoiceId: string): Promise<"deleted" | "finalized" | "gone"> {
  const ixHeaders = {
    "x-account-name": config.ix_account_name!,
    "x-api-key": config.ix_api_key!,
    "x-env": config.ix_environment === "production" ? "prod" as const : "dev" as const,
  };
  try {
    const { data, error } = await IxApi.v2.documents.byId.get({ headers: ixHeaders, path: { id: Number(invoiceId) } });
    if (error || !data?.data) return "gone";
    const state = String((data.data as any).status ?? (data.data as any).state ?? "").toLowerCase();
    if (state === "deleted") return "gone";
    if (state !== "draft") return "finalized";

    const { error: delError } = await IxApi.v2.changeState.post({
      body: {
        type: config.ix_document_type === "invoice_receipt" ? "invoice_receipt" : "invoice",
        id: Number(invoiceId),
        state: "deleted",
      },
      headers: ixHeaders,
    });
    if (delError) {
      console.warn(`[Rioko] Could not delete stale draft ${invoiceId}: ${JSON.stringify(delError)}`);
      return "gone";
    }
    return "deleted";
  } catch (e: any) {
    console.warn(`[Rioko] discardIxDraft(${invoiceId}) failed: ${e?.message ?? e}`);
    return "gone";
  }
}

async function adminCreateOrder(env: Env, config: IRequestConfig, order: any, opts: { skipIxReferenceCheck?: boolean } = {}): Promise<OrderResult> {
  const appStorage = new AppStorage(env, config.shopify_domain!);
  const orderId = String(order.id);

  try {
    // Check if already processed
    const alreadyExists = await appStorage.isInvoiceAlreadyProcessed(orderId);
    if (alreadyExists) {
      return { order_id: order.id, order_number: order.order_number, status: "skipped", message: "Already processed in DB" };
    }

    // Zero-amount short-circuit: PT fiscal rules don't require invoicing 0€
    // orders (gift cards, 100% discount, test orders). IX would also reject
    // the request, so we skip cleanly and log it so the merchant can see why.
    // `invoice_zero_total` lets a wholesale shop document 100%-discounted
    // orders (samples, replacements) instead of skipping them. See orders-created.ts.
    const orderTotal = parseFloat(String(order.total_price ?? order.current_total_price ?? "0"));
    if ((!Number.isFinite(orderTotal) || orderTotal <= 0) && Number(config.invoice_zero_total) !== 1) {
      await appStorage.saveLog({
        shopify_domain: config.shopify_domain,
        topic: "orders/created",
        payload: JSON.stringify({ orderId, total: orderTotal }),
        response: "Skipped: zero-amount order — no invoice required",
        status: 200,
      });
      return { order_id: order.id, order_number: order.order_number, status: "skipped", message: "Zero-amount order — invoice not required (total €0,00)" };
    }

    const ixRef = saleReference(order.order_number);
    const ixHeaders = {
      "x-account-name": config.ix_account_name!,
      "x-api-key": config.ix_api_key!,
      "x-env": config.ix_environment === "production" ? "prod" as const : "dev" as const,
    };

    if (!opts.skipIxReferenceCheck) {
      // Check if invoice already exists in InvoiceXpress (retrying leg — a flaky
      // ix-proxy "not found" must never let us double-invoice a phantom order).
      const existingId = await findIxInvoiceByReference(ixHeaders, ixRef);

      if (existingId) {
        // Exists in IX but not in our DB — save the reference
        await appStorage.saveProcessedInvoice(orderId, existingId);
        await logDocumentEvent(env, {
          externalId: orderId,
          event: "created",
          dedupKey: `created:${existingId}`,
          invoiceId: String(existingId),
          userId: config.user_id,
          shopifyDomain: config.shopify_domain,
          sourceKind: "shopify",
          destinationKind: "invoicexpress",
          actor: "backfill",
          summary: `O destino já tinha o documento ${existingId} com a referência ${ixRef}; foi associado à encomenda ${order.name ?? orderId} em vez de emitir um novo.`,
          detail: { reference: ixRef, linked: true },
        });
        return { order_id: order.id, order_number: order.order_number, status: "skipped", message: `Already exists in InvoiceXpress (id=${existingId}), synced to DB` };
      }
    }

    // Normalize order. Same flag as the live create handlers so the
    // reconciliation sweep + manual reemit are also Hostinger-independent
    // (shadow-validated byte-identical). Refund path stays on Hostinger.
    const shopify = new Shopify(env.NORMALIZE_SHOPIFY_ORDER_API_KEY, config);
    const normalizedOrderResponse = env.NORMALIZE_IN_WORKER === "1"
      ? await shopify.normalizeOrderLocal(orderId)
      : await shopify.normalizeOrder(orderId);

    if (!normalizedOrderResponse) {
      return { order_id: order.id, order_number: order.order_number, status: "error", message: "Failed to normalize order" };
    }

    const ixBuilder = new IxBuilder(config);
    const { invoice, nifHold } = ixBuilder.createInvoiceFromNormalizedOrder(normalizedOrderResponse.normalized);

    const { res: ixCreateResponse, via } = await createIxInvoiceWithFallback(
      ixHeaders,
      invoice,
      config.ix_document_type === "invoice_receipt" ? "invoice_receipt" : "invoice",
      { forceTaxRate: config.force_tax_rate, forceShippingTaxRate: config.force_shipping_tax_rate },
    );

    if (ixCreateResponse.data?.data?.id) {
      // Writing the hold (or NULL) here is what makes a re-emit the fix for a
      // held order: the merchant corrects the address in Shopify, re-emits, and
      // the fresh build has no hold, so finalize is unblocked.
      const invoiceId = String(ixCreateResponse.data.data.id);
      const holdReason = nifHold ? nifHoldReason(nifHold) : null;
      await appStorage.saveProcessedInvoice(orderId, invoiceId, { holdReason });

      // The intent, on THE path that has stamped wrong exemption codes before:
      // every confirmed M99 case (Mindful Muse, Bikini Books, DO IT BRAVELY,
      // lliberta) came from a backfill/re-emission, and none of them recorded
      // what was sent — so the 04:00 sweep can now hold the next backfill to it.
      await logDocumentEvent(env, {
        externalId: orderId,
        event: "built",
        dedupKey: `built:${invoiceId}`,
        invoiceId,
        userId: config.user_id,
        shopifyDomain: config.shopify_domain,
        sourceKind: "shopify",
        destinationKind: "invoicexpress",
        actor: "backfill",
        summary: `Documento ${invoiceId} emitido (backfill/reemissão) para a encomenda ${order.name ?? orderId} por ${Number(order.total_price ?? 0).toFixed(2)} €${invoice.tax_exemption_reason ? `, isenção ${invoice.tax_exemption_reason}` : ""}.`,
        detail: {
          intent: {
            total: Number.isFinite(Number(order.total_price)) ? Number(order.total_price) : null,
            reference: invoice.reference ?? null,
            exemptionCode: invoice.tax_exemption_reason ?? null,
          },
          via,
          holdReason,
        },
      });

      if (holdReason) {
        await logDocumentEvent(env, {
          externalId: orderId,
          event: "held",
          dedupKey: `held:${invoiceId}`,
          invoiceId,
          userId: config.user_id,
          shopifyDomain: config.shopify_domain,
          sourceKind: "shopify",
          destinationKind: "invoicexpress",
          actor: "backfill",
          summary: `Documento ${invoiceId} ficou retido em rascunho para revisão: ${holdReason}.`,
          detail: { invoiceId, holdReason },
        });
      }

      const suffix = via !== "none" ? ` (cliente recriado via fallback: ${via})` : "";
      const holdNote = holdReason ? ` — em rascunho: ${holdReason}` : "";
      return { order_id: order.id, order_number: order.order_number, status: "created", message: `Invoice ${invoiceId} created${suffix}${holdNote}` };
    }

    const ixRefusal = JSON.stringify(ixCreateResponse.error ?? ixCreateResponse.data).slice(0, 1500);
    await logDocumentEvent(env, {
      externalId: orderId,
      event: "create_failed",
      dedupKey: `create_failed:${orderId}:${new Date().toISOString().slice(0, 10)}`,
      userId: config.user_id,
      shopifyDomain: config.shopify_domain,
      sourceKind: "shopify",
      destinationKind: "invoicexpress",
      actor: "backfill",
      summary: `O InvoiceXpress recusou emitir o documento da encomenda ${order.name ?? orderId} (backfill/reemissão): ${explainPlatformError(ixRefusal, "invoicexpress")}`,
      detail: { error: ixRefusal },
    });
    return { order_id: order.id, order_number: order.order_number, status: "error", message: `IX API returned no id: ${ixRefusal}` };
  } catch (e) {
    return { order_id: order.id, order_number: order.order_number, status: "error", message: String(e) };
  }
}

async function adminFinalizeOrder(
  env: Env,
  config: IRequestConfig,
  order: any,
  seriesLastFinalizedDate?: string | null,
): Promise<OrderResult> {
  const appStorage = new AppStorage(env, config.shopify_domain!);
  const orderId = String(order.id);

  try {
    const invoiceRef = await appStorage.getInvoiceByOrderId(orderId);
    if (!invoiceRef) {
      return { order_id: order.id, order_number: order.order_number, status: "skipped", message: "No invoice found in DB — run create_orders first" };
    }

    // Held for a human (invalid NIF in the address line). Finalizing in bulk
    // would certify exactly the documents someone asked us to hold. Correct the
    // order in Shopify and re-emit — that clears the hold.
    if (invoiceRef.hold_reason) {
      return { order_id: order.id, order_number: order.order_number, status: "skipped", message: `Em rascunho por decisão: ${invoiceRef.hold_reason}. Corrija a encomenda e reemita.` };
    }

    const ixHeaders = {
      "x-account-name": config.ix_account_name!,
      "x-api-key": config.ix_api_key!,
      "x-env": config.ix_environment === "production" ? "prod" as const : "dev" as const,
    };

    // Finalize as close to the transaction date as IX will take. NOT
    // `actualizeDateBeforeChange` — that flag moves `date` to today and leaves
    // `due_date` behind, which IX then rejects; see finalizeDraftClosestToDate.
    const ixDocType = config.ix_document_type === "invoice_receipt" ? "invoice_receipt" as const : "invoice" as const;
    const outcome = await finalizeDraftClosestToDate(config, invoiceRef.invoice_id, ixDocType, ixHeaders, {
      // `undefined` = look it up; the batch caller passes it so we don't hit the
      // series endpoint once per order.
      ...(seriesLastFinalizedDate !== undefined ? { seriesLastFinalizedDate } : {}),
      // The Shopify order is right here, so the draft can be checked against
      // what was actually paid before anything is certified.
      paidTotal: Number.isFinite(Number(order?.total_price)) ? Number(order.total_price) : null,
    });

    if (outcome.status === "skipped") {
      return { order_id: order.id, order_number: order.order_number, status: "skipped", message: outcome.message };
    }
    if (outcome.status === "error") {
      return { order_id: order.id, order_number: order.order_number, status: "error", message: outcome.message };
    }

    // Send email if configured. Shared with the webhook paths so the admin
    // tool can't drift from them again — it used to require the client to carry
    // a fiscal_id, which silently emailed nobody on every Consumidor Final sale.
    //
    // `saleDate` is the date the document had BEFORE we moved it. Without it a
    // backlog document, whose date we just pushed to today to satisfy IX's
    // series rule, reads as a fresh sale and the buyer gets mailed an invoice
    // for something they bought months ago.
    const emailOutcome = await sendIxDocumentEmail(config, invoiceRef.invoice_id, { saleDate: outcome.originalDate });
    console.log(`[Rioko] ${describeIxEmailOutcome(invoiceRef.invoice_id, emailOutcome)}`);

    return { order_id: order.id, order_number: order.order_number, status: "finalized", message: `Invoice ${invoiceRef.invoice_id}: ${outcome.message}`, finalized_date: outcome.date };
  } catch (e) {
    return { order_id: order.id, order_number: order.order_number, status: "error", message: String(e) };
  }
}
