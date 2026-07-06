import type { Env } from "../env";
import type { IRequestConfig } from "../storage";
import { AppStorage } from "../storage";
import { IxApi } from "../api/ix";
import { runAdapterPipeline } from "./generic-pipeline";
import { sendDevModeEmail } from "./notify";
import { stripeFetch } from "../services/stripe";

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

async function loadStripeConnectionConfig(env: Env, userId: string): Promise<StripeConnConfig | null> {
  const row: any = await env.DB.prepare(
    "SELECT source_config_json FROM connections WHERE user_id = ? AND source_kind = 'stripe' LIMIT 1"
  ).bind(userId).first();
  if (!row?.source_config_json) return null;
  try { return JSON.parse(row.source_config_json) as StripeConnConfig; } catch { return null; }
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

// Walks Stripe `payment_intents.list` over a date range. Filters client-side to
// status=succeeded — Stripe's PI list endpoint doesn't have a status filter, so
// we paginate and skip.
async function listStripePaymentIntents(
  restrictedKey: string,
  fromIso: string,
  toIso: string,
  limit = 500,
  stripeAccount?: string | null,
): Promise<any[]> {
  const fromUnix = Math.floor(new Date(fromIso).getTime() / 1000);
  const toUnix = Math.floor(new Date(toIso).getTime() / 1000);
  const out: any[] = [];
  let startingAfter: string | null = null;

  while (out.length < limit) {
    const params = new URLSearchParams();
    params.set("created[gte]", String(fromUnix));
    params.set("created[lte]", String(toUnix));
    params.set("limit", "100");
    if (startingAfter) params.set("starting_after", startingAfter);

    const res = await stripeFetch("payment_intents", restrictedKey, { stripeAccount, query: params });
    if (!res.ok) {
      throw new Error(`Stripe paymentIntents.list ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const body: any = await res.json();
    const page: any[] = body.data ?? [];
    for (const pi of page) {
      if (pi.status === "succeeded") out.push(pi);
    }
    if (!body.has_more || page.length === 0) break;
    startingAfter = page[page.length - 1]?.id ?? null;
    if (!startingAfter) break;
  }
  return out;
}

async function fetchStripeObject(restrictedKey: string, stripeId: string, stripeAccount?: string | null): Promise<{ event: any } | { error: string }> {
  const prefix = stripeId.split("_")[0];
  let path: string;
  let eventType: string;
  switch (prefix) {
    case "pi": path = `payment_intents/${encodeURIComponent(stripeId)}`; eventType = "payment_intent.succeeded"; break;
    case "ch": path = `charges/${encodeURIComponent(stripeId)}`; eventType = "charge.succeeded"; break;
    case "cs": path = `checkout/sessions/${encodeURIComponent(stripeId)}`; eventType = "checkout.session.completed"; break;
    case "in": path = `invoices/${encodeURIComponent(stripeId)}`; eventType = "invoice.paid"; break;
    default: return { error: `Unsupported Stripe id prefix: ${prefix}` };
  }

  const res = await stripeFetch(path, restrictedKey, { stripeAccount });
  if (!res.ok) return { error: `Stripe ${path} ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const obj: any = await res.json();
  // Synthesized events from backfill/reemit carry no `account` field; stamp the
  // connected account id so downstream enrichment scopes its reads correctly.
  return { event: { type: eventType, data: { object: obj }, ...(stripeAccount ? { account: stripeAccount } : {}) } };
}

// Returns the externalId the pipeline would dedup on for a given event payload.
// Mirrors StripeSource.externalId so backfill can pre-check processed_orders.
function externalIdFromEvent(event: any): string {
  const obj = event?.data?.object;
  if (!obj) return String(event?.id ?? "");
  if (event.type === "charge.refunded" && obj.payment_intent) return String(obj.payment_intent);
  if (event.type === "checkout.session.completed" && obj.payment_intent) return String(obj.payment_intent);
  return String(obj.id ?? "");
}

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

  const connCfg = await loadStripeConnectionConfig(env, config.user_id);
  if (!connCfg?.restricted_key) {
    return { error: "No Stripe restricted_key on connection. Save Stripe credentials first." };
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
  const existing = await appStorage.getProcessedOrderIds(ids);
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
        env, config, source: "stripe", destination: "invoicexpress",
        topic: "created", webhookId: null, body: event,
        sourceConfig: connCfg,
      });
      results.push({ external_id: externalId, status: "created", message: "Invoice created via backfill" });
    } catch (e: any) {
      results.push({ external_id: externalId, status: "error", message: String(e?.message ?? e) });
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
  if (options.force) await appStorage.deleteProcessedInvoice(externalId, "stripe");

  try {
    await runAdapterPipeline({
      env, config, source: "stripe",
      destination: (conn.destinationKind as any) ?? "invoicexpress",
      topic: "created", webhookId: null, body: event,
      sourceConfig: connCfg,
      destinationConfig: conn.destinationConfig,
    });
  } catch (e: any) {
    const err = `Pipeline failed: ${e?.message ?? e}`;
    await appStorage.finishDevJob(jobId, "error", { error: err }, []);
    return { job_id: jobId, status: "error", error: err };
  }

  const summary = { external_id: externalId, stripe_id: stripeId, force: !!options.force };
  await appStorage.finishDevJob(jobId, "success", summary, [summary]);

  if (options.notify_emails && options.notify_emails.length > 0) {
    await sendDevModeEmail({
      recipients: options.notify_emails,
      subject: `Rioko Dev Mode — Stripe re-emit ${stripeId}`,
      body: `Stripe id: ${stripeId}\nExternal id: ${externalId}\nForce: ${options.force ? "yes" : "no"}\nReason: ${options.reason ?? "—"}\nJob ID: ${jobId}`,
    });
  }

  return { job_id: jobId, status: "success", ...summary };
}

async function lookupStripeInvoice(env: Env, config: IRequestConfig, externalId: string) {
  const appStorage = new AppStorage(env, config.shopify_domain ?? undefined, config.user_id);
  const invoiceRef = await appStorage.getInvoiceByOrderId(externalId);
  if (!invoiceRef) return { error: `No invoice registered for ${externalId}` };

  const ixHeaders = {
    "x-account-name": config.ix_account_name!,
    "x-api-key": config.ix_api_key!,
    "x-env": config.ix_environment === "production" ? "prod" as const : "dev" as const,
  };
  const { data, error } = await IxApi.v2.documents.byId.get({
    headers: ixHeaders, path: { id: Number(invoiceRef.invoice_id) },
  });
  if (error || !data?.data) return { error: `IX fetch failed: ${JSON.stringify(error)}` };
  return { invoiceId: invoiceRef.invoice_id, ixInvoice: data.data };
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

  const lookup = await lookupStripeInvoice(env, config, stripeId);
  if ("error" in lookup) {
    await appStorage.finishDevJob(jobId, "error", { error: lookup.error }, []);
    return { job_id: jobId, status: "error", error: lookup.error };
  }

  const state = (lookup.ixInvoice as any).status ?? (lookup.ixInvoice as any).state;
  if (state === "deleted") {
    await appStorage.deleteProcessedInvoice(stripeId, "stripe");
    const summary = { invoice_id: lookup.invoiceId, external_id: stripeId, message: "Invoice already deleted in IX — removed stale DB link." };
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

  await appStorage.deleteProcessedInvoice(stripeId, "stripe");
  const summary = { invoice_id: lookup.invoiceId, external_id: stripeId };
  await appStorage.finishDevJob(jobId, "success", summary, [summary]);

  if (options.notify_emails && options.notify_emails.length > 0) {
    await sendDevModeEmail({
      recipients: options.notify_emails,
      subject: `Rioko Dev Mode — Stripe draft eliminado ${stripeId}`,
      body: `Invoice ${lookup.invoiceId} eliminado.\nStripe id: ${stripeId}\nReason: ${options.reason ?? "—"}\nTriggered by: ${options.triggered_by ?? "—"}\nJob ID: ${jobId}`,
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

  const lookup = await lookupStripeInvoice(env, config, stripeId);
  if ("error" in lookup) {
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

  const reference = `StripeCancel ${stripeId}`;

  // Idempotency: check existing CNs for this invoice.
  const { data: rel } = await IxApi.v2.documents.byId.related.get({
    headers: ixHeaders, path: { id: Number(lookup.invoiceId) },
  });
  const existing = (rel?.data?.documents ?? []).find((d: any) => d.type === "CreditNote" && d.reference === reference);
  if (existing) {
    const summary = { invoice_id: lookup.invoiceId, credit_note_id: existing.id, message: "Credit note already exists, skipped" };
    await appStorage.finishDevJob(jobId, "success", summary, [summary]);
    return { job_id: jobId, status: "success", ...summary };
  }

  // Build CN from the IX invoice's own line items. We don't refetch from Stripe
  // because the Stripe-source mapping produces single-line items anyway and the
  // IX side has everything we need with the same tax breakdown.
  const inv: any = lookup.ixInvoice;
  const itemsForCn = Array.isArray(inv.items) ? inv.items.map((it: any) => ({
    quantity: Number(it.quantity ?? 1),
    name: String(it.name ?? "Refund"),
    ...(it.description ? { description: String(it.description) } : {}),
    unit_price: Number(it.unit_price ?? 0),
    tax: it.tax?.id
      ? { id: Number(it.tax.id), name: String(it.tax.name ?? ""), value: Number(it.tax.value ?? 0) }
      : { name: String(it.tax?.name ?? "VAT"), value: Number(it.tax?.value ?? 0) },
  })) : [];

  const requireTaxExemption = itemsForCn.some((it: any) =>
    typeof it.tax === "number" ? it.tax === 0 : it.tax.value === 0
  );

  const creditNote: any = {
    date: new Date().toISOString().slice(0, 10),
    due_date: new Date().toISOString().slice(0, 10),
    client: inv.client
      ? {
          ...(inv.client.id ? { id: Number(inv.client.id) } : {}),
          ...(inv.client.name ? { name: String(inv.client.name) } : { name: "" }),
          ...(inv.client.email ? { email: String(inv.client.email) } : {}),
          ...(inv.client.fiscal_id ? { fiscal_id: String(inv.client.fiscal_id) } : {}),
          ...(inv.client.address ? { address: String(inv.client.address) } : {}),
          ...(inv.client.postal_code ? { postal_code: String(inv.client.postal_code) } : {}),
          ...(inv.client.country ? { country: String(inv.client.country) } : {}),
          ...(inv.client.city ? { city: String(inv.client.city) } : {}),
        }
      : { name: "" },
    items: itemsForCn,
    reference,
    tax_exemption_reason: requireTaxExemption
      ? (inv as any)?.tax_exemption ?? config.ix_exemption_reason ?? undefined
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
      body: { type: "credit_note", id: Number(cnId), state: "finalized" },
      headers: ixHeaders,
    });
  }

  const summary = { invoice_id: lookup.invoiceId, credit_note_id: cnId, external_id: stripeId };
  await appStorage.finishDevJob(jobId, "success", summary, [summary]);

  if (options.notify_emails && options.notify_emails.length > 0) {
    await sendDevModeEmail({
      recipients: options.notify_emails,
      subject: `Rioko Dev Mode — Stripe credit note ${stripeId}`,
      body: `Credit note ${cnId} emitida para invoice ${lookup.invoiceId}.\nStripe id: ${stripeId}\nReason: ${options.reason ?? "—"}\nTriggered by: ${options.triggered_by ?? "—"}\nJob ID: ${jobId}`,
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
  } catch {
    return null;
  }
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
    date_strategy?: DateStrategy;
    from_date?: string | null;
    to_date?: string | null;
  },
) {
  const appStorage = new AppStorage(env, config.shopify_domain ?? undefined, config.user_id);
  const limit = Math.min(options.limit ?? 100, 500);
  const dryRun = !!options.dry_run;
  const strategy: DateStrategy = options.date_strategy ?? "closest_available";
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

  const ixHeaders = {
    "x-account-name": config.ix_account_name!,
    "x-api-key": config.ix_api_key!,
    "x-env": config.ix_environment === "production" ? "prod" as const : "dev" as const,
  };
  const ixDocType = config.ix_document_type === "invoice_receipt" ? "invoice_receipt" as const : "invoice" as const;
  const today = todayUtcYmd();

  let processed = await appStorage.listProcessedInvoicesByUser(config.user_id, "stripe", limit, "asc");

  if ((fromDate || toDate) && processed.length > 0) {
    processed = processed.filter(r => {
      const created = r.created_at ?? "";
      if (fromDate && created < fromDate) return false;
      if (toDate && created > toDate) return false;
      return true;
    });
  }

  const results: Array<{ external_id: string; invoice_id: string; status: "finalized" | "dry_run" | "skipped" | "error"; message: string; original_date?: string; target_date?: string }> = [];

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
        results.push({ external_id: row.id, invoice_id: row.invoice_id, status: "error", message: `Fetch failed: ${JSON.stringify(docError)}` });
        continue;
      }
      const doc: any = docData.data;
      const state = doc.status ?? doc.state;
      if (state !== "draft") {
        results.push({ external_id: row.id, invoice_id: row.invoice_id, status: "skipped", message: `Not draft (status=${state})` });
        continue;
      }

      const originalDate = parseIxDate(doc.date);
      if (!originalDate) {
        results.push({ external_id: row.id, invoice_id: row.invoice_id, status: "error", message: `Could not parse draft date '${doc.date}'` });
        continue;
      }

      let targetDate: string;
      if (strategy === "today") {
        targetDate = today;
      } else {
        targetDate = originalDate;
        if (lastFinalizedDate && lastFinalizedDate > targetDate) targetDate = lastFinalizedDate;
      }

      const dateChanged = targetDate !== originalDate;
      const appendNote = dateChanged
        ? `Fatura referente ao pagamento Stripe ${row.id} de ${formatPtDate(originalDate)}`
        : null;
      const existingObs = typeof doc.observations === "string" ? doc.observations.trim() : "";
      const newObservations = appendNote
        ? (existingObs ? `${existingObs} | ${appendNote}` : appendNote).slice(0, 200)
        : existingObs;

      if (dryRun) {
        results.push({
          external_id: row.id,
          invoice_id: row.invoice_id,
          status: "dry_run",
          message: dateChanged
            ? `Would PUT date ${formatPtDate(originalDate)} → ${formatPtDate(targetDate)} and append observation, then finalize`
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
          results.push({ external_id: row.id, invoice_id: row.invoice_id, status: "error", message: `PUT date failed: ${JSON.stringify(putError)}`, original_date: originalDate, target_date: targetDate });
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
        results.push({ external_id: row.id, invoice_id: row.invoice_id, status: "error", message: JSON.stringify(error), original_date: originalDate, target_date: targetDate });
      } else {
        lastFinalizedDate = targetDate;
        results.push({
          external_id: row.id,
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
