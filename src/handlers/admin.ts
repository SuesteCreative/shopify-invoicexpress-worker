import type { Env } from "../env";
import type { IRequestConfig } from "../storage";
import { AppStorage } from "../storage";
import { Shopify } from "../shopify";
import { IxApi } from "../api/ix";
import { IxBuilder } from "../ix/builder";
import { createIxInvoiceWithFallback } from "../ix/create-invoice";
import { sendDevModeEmail } from "./notify";

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
};

export interface ProcessOrdersOptions {
  dry_run?: boolean;
  since_last_processed?: boolean;
  notify_emails?: string[];
  triggered_by?: string | null;
  reason?: string | null;
}

async function fetchShopifyOrders(config: IRequestConfig, from: string, to: string): Promise<any[]> {
  const allOrders: any[] = [];
  const apiVersion = config.shopify_api_version ?? "2026-01";
  let url: string | null = `https://${config.shopify_domain}/admin/api/${apiVersion}/orders.json?processed_at_min=${encodeURIComponent(from)}&processed_at_max=${encodeURIComponent(to)}&status=any&limit=250`;

  while (url) {
    const response = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": config.shopify_token!,
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Shopify API error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as { orders: any[] };
    allOrders.push(...data.orders);

    // Handle pagination via Link header
    const linkHeader = response.headers.get("Link");
    url = null;
    if (linkHeader) {
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (nextMatch) {
        url = nextMatch[1];
      }
    }
  }

  return allOrders;
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
    const ixRef = `Order #${order.order_number}`;
    const ixExisting = await IxApi.v2.documents.reference.post({
      headers: ixHeaders,
      body: { reference: ixRef },
    });

    if (ixExisting.data?.data?.id) {
      // Exists in IX but not in our DB — sync it
      await appStorage.saveProcessedInvoice(String(order.id), String(ixExisting.data.data.id));
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

  for (const order of orders) {
    if (dryRun) {
      results.push(await adminDryRunCreate(env, config, order, type));
    } else if (type === "create_orders") {
      results.push(await adminCreateOrder(env, config, order));
    } else {
      results.push(await adminFinalizeOrder(env, config, order));
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
    const ixExisting = await IxApi.v2.documents.reference.post({
      headers: ixHeaders,
      body: { reference: `Order #${order.order_number}` },
    });
    if (ixExisting.data?.data?.id) {
      return { order_id: order.id, order_number: order.order_number, status: "skipped", message: `Exists in IX (id=${ixExisting.data.data.id})` };
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
    const summary = { error: `Order #${orderNumber} not found in Shopify. If the order exists in the store, the access token is likely missing the read_all_orders scope (Shopify's Admin API only returns the last 60 days of orders without it). Add read_all_orders to the Custom App configuration, regenerate the token, and retry.` };
    await appStorage.finishDevJob(jobId, "error", summary, []);
    return { job_id: jobId, status: "error", ...summary };
  }

  if (order.financial_status !== "paid") {
    const summary = { error: `Order #${orderNumber} is not paid (financial_status=${order.financial_status})` };
    await appStorage.finishDevJob(jobId, "error", summary, []);
    return { job_id: jobId, status: "error", ...summary };
  }

  if (options.force) {
    await appStorage.deleteProcessedInvoice(String(order.id));
  }

  const result = await adminCreateOrder(env, config, order, { skipIxReferenceCheck: !!options.force });
  const status: "success" | "error" = result.status === "created" ? "success" : "error";
  const summary = { result, force: !!options.force };
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
  const reference = `OrderCancel #${orderNumber}`;
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
      ? (lookup.ixInvoice as any)?.tax_exemption ?? config.ix_exemption_reason ?? undefined
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

function parseIxDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function formatPtDate(isoYmd: string): string {
  const [y, m, d] = isoYmd.split("-");
  return `${d}/${m}/${y}`;
}

function todayUtcYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

// Reads the most recent finalized invoice date in the IX account's series.
// IX rejects `changeState → finalized` when the document's date is earlier
// than the series' latest finalized date, so we use this as the baseline for
// the `closest_available` strategy. Hits the IX legacy JSON endpoint directly
// since the v2 SDK proxy doesn't expose a list endpoint.
async function fetchSeriesLastFinalizedDate(
  config: IRequestConfig,
  docKind: "invoice" | "invoice_receipt",
): Promise<string | null> {
  try {
    const account = config.ix_account_name;
    const apiKey = config.ix_api_key;
    if (!account || !apiKey) return null;
    const path = docKind === "invoice_receipt" ? "invoice_receipts.json" : "invoices.json";
    const url = `https://${account}.app.invoicexpress.com/${path}?api_key=${apiKey}&status%5B%5D=settled&status%5B%5D=final&order_by=date_desc&per_page=1`;
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const list = data?.invoices ?? data?.invoice_receipts ?? [];
    if (!Array.isArray(list) || list.length === 0) return null;
    return parseIxDate(list[0]?.date ?? null);
  } catch (e) {
    console.warn("[Rioko] fetchSeriesLastFinalizedDate failed:", e);
    return null;
  }
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

  for (const row of processed) {
    try {
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
        const items = Array.isArray(doc.items) ? doc.items.map((it: any) => ({
          quantity: Number(it.quantity),
          name: String(it.name ?? ""),
          ...(it.description ? { description: String(it.description) } : {}),
          unit_price: Number(it.unit_price),
          tax: it.tax?.id
            ? { id: Number(it.tax.id), name: String(it.tax.name ?? ""), value: Number(it.tax.value ?? 0) }
            : { name: String(it.tax?.name ?? ""), value: Number(it.tax?.value ?? 0) },
          ...(typeof it.discount === "number" && it.discount > 0 ? { discount: it.discount } : {}),
        })) : [];

        const client = doc.client ? {
          ...(doc.client.id ? { id: Number(doc.client.id) } : {}),
          ...(doc.client.name ? { name: String(doc.client.name) } : {}),
          ...(doc.client.email ? { email: String(doc.client.email) } : {}),
          ...(doc.client.fiscal_id ? { fiscal_id: String(doc.client.fiscal_id) } : {}),
          ...(doc.client.address ? { address: String(doc.client.address) } : {}),
          ...(doc.client.postal_code ? { postal_code: String(doc.client.postal_code) } : {}),
          ...(doc.client.country ? { country: String(doc.client.country) } : {}),
          ...(doc.client.city ? { city: String(doc.client.city) } : {}),
          ...(doc.client.phone ? { phone: String(doc.client.phone) } : {}),
        } : { name: "" };

        const putBody: any = {
          type: ixDocType,
          data: {
            date: targetDate,
            due_date: targetDate,
            client,
            items,
            observations: newObservations,
            ...(doc.reference ? { reference: String(doc.reference) } : {}),
            ...(doc.tax_exemption ? { tax_exemption_reason: String(doc.tax_exemption) } : {}),
          },
        };

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

async function fetchOrdersByIds(config: IRequestConfig, orderIds: number[]): Promise<any[]> {
  const apiVersion = config.shopify_api_version ?? "2026-01";
  const ids = orderIds.join(",");
  const url = `https://${config.shopify_domain}/admin/api/${apiVersion}/orders.json?ids=${ids}&status=any&limit=250`;

  const response = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": config.shopify_token!,
      "Accept": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Shopify API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json() as { orders: any[] };
  return data.orders;
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
    const orderTotal = parseFloat(String(order.total_price ?? order.current_total_price ?? "0"));
    if (!Number.isFinite(orderTotal) || orderTotal <= 0) {
      await appStorage.saveLog({
        shopify_domain: config.shopify_domain,
        topic: "orders/created",
        payload: JSON.stringify({ orderId, total: orderTotal }),
        response: "Skipped: zero-amount order — no invoice required",
        status: 200,
      });
      return { order_id: order.id, order_number: order.order_number, status: "skipped", message: "Zero-amount order — invoice not required (total €0,00)" };
    }

    const ixRef = `Order #${order.order_number}`;
    const ixHeaders = {
      "x-account-name": config.ix_account_name!,
      "x-api-key": config.ix_api_key!,
      "x-env": config.ix_environment === "production" ? "prod" as const : "dev" as const,
    };

    if (!opts.skipIxReferenceCheck) {
      // Check if invoice already exists in InvoiceXpress
      const ixExisting = await IxApi.v2.documents.reference.post({
        headers: ixHeaders,
        body: { reference: ixRef },
      });

      if (ixExisting.data?.data?.id) {
        // Exists in IX but not in our DB — save the reference
        await appStorage.saveProcessedInvoice(orderId, String(ixExisting.data.data.id));
        return { order_id: order.id, order_number: order.order_number, status: "skipped", message: `Already exists in InvoiceXpress (id=${ixExisting.data.data.id}), synced to DB` };
      }
    }

    // Normalize order
    const shopify = new Shopify(env.NORMALIZE_SHOPIFY_ORDER_API_KEY, config);
    const normalizedOrderResponse = await shopify.normalizeOrder(orderId);

    if (!normalizedOrderResponse) {
      return { order_id: order.id, order_number: order.order_number, status: "error", message: "Failed to normalize order" };
    }

    const ixBuilder = new IxBuilder(config);
    const { invoice } = ixBuilder.createInvoiceFromNormalizedOrder(normalizedOrderResponse.normalized);

    const { res: ixCreateResponse, via } = await createIxInvoiceWithFallback(
      ixHeaders,
      invoice,
      config.ix_document_type === "invoice_receipt" ? "invoice_receipt" : "invoice",
    );

    if (ixCreateResponse.data?.data?.id) {
      await appStorage.saveProcessedInvoice(orderId, String(ixCreateResponse.data.data.id));
      const suffix = via !== "none" ? ` (cliente recriado via fallback: ${via})` : "";
      return { order_id: order.id, order_number: order.order_number, status: "created", message: `Invoice ${ixCreateResponse.data.data.id} created${suffix}` };
    }

    return { order_id: order.id, order_number: order.order_number, status: "error", message: `IX API returned no id: ${JSON.stringify(ixCreateResponse.error ?? ixCreateResponse.data)}` };
  } catch (e) {
    return { order_id: order.id, order_number: order.order_number, status: "error", message: String(e) };
  }
}

async function adminFinalizeOrder(env: Env, config: IRequestConfig, order: any): Promise<OrderResult> {
  const appStorage = new AppStorage(env, config.shopify_domain!);
  const orderId = String(order.id);

  try {
    const invoiceRef = await appStorage.getInvoiceByOrderId(orderId);
    if (!invoiceRef) {
      return { order_id: order.id, order_number: order.order_number, status: "skipped", message: "No invoice found in DB — run create_orders first" };
    }

    const ixHeaders = {
      "x-account-name": config.ix_account_name!,
      "x-api-key": config.ix_api_key!,
      "x-env": config.ix_environment === "production" ? "prod" as const : "dev" as const,
    };

    // Finalize the invoice
    const { data, error } = await IxApi.v2.changeState.post({
      body: {
        type: config.ix_document_type === "invoice_receipt" ? "invoice_receipt" : "invoice",
        id: Number(invoiceRef.invoice_id),
        state: "finalized",
        actualizeDateBeforeChange: true
      },
      headers: ixHeaders,
    });

    if (error) {
      return { order_id: order.id, order_number: order.order_number, status: "error", message: `Finalize failed: ${JSON.stringify(error)}` };
    }

    // Send email if configured
    if (config.ix_send_email) {
      const { data: invoiceData, error: invoiceError } = await IxApi.v2.documents.byId.get({
        headers: ixHeaders,
        path: { id: Number(invoiceRef.invoice_id) },
      });

      if (!invoiceError && invoiceData?.data?.client?.email && invoiceData?.data?.client?.fiscal_id) {
        await IxApi.v2.documents.byId.email.post({
          body: {
            message: {
              client: {
                email: invoiceData.data.client.email,
                save: "0",
              },
              body: config.ix_email_body ?? undefined,
              subject: config.ix_email_subject ?? undefined,
            },
          },
          path: { id: Number(invoiceRef.invoice_id) },
          query: {
            type: config.ix_document_type === "invoice_receipt" ? "invoice_receipts" : "invoices",
          },
          headers: ixHeaders,
        });
      }
    }

    return { order_id: order.id, order_number: order.order_number, status: "finalized", message: `Invoice ${invoiceRef.invoice_id} finalized` };
  } catch (e) {
    return { order_id: order.id, order_number: order.order_number, status: "error", message: String(e) };
  }
}
