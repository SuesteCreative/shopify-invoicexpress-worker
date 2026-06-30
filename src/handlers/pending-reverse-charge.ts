// Shared logic for the VIES retry cron AND the manual approve/reject admin
// endpoints. Both paths end up calling `submitInvoiceForPendingRow` once they
// know whether the buyer is reverse-charge-eligible or not.

import type { Env } from "../env";
import type { Normalized } from "../api/normalize-shopify";
import type { PendingReverseChargeRow } from "../storage";
import { AppStorage } from "../storage";
import { IxApi } from "../api/ix";
import { IxBuilder } from "../ix/builder";
import { makeViesChecker } from "../ix/vies";
import { reportIncident } from "../services/incidents";

const RETRY_BACKOFF_MS = [15 * 60_000, 60 * 60_000];

export type DispositionFor = "apply" | "reject";

export async function submitInvoiceForPendingRow(
  env: Env,
  row: PendingReverseChargeRow,
  disposition: DispositionFor,
): Promise<{ ok: boolean; invoiceId?: string; error?: string }> {
  const appStorage = new AppStorage(env, row.shopify_domain, row.user_id);
  const config = await appStorage.loadConfig();
  if (!config) return { ok: false, error: "No config for shop" };

  // Idempotency — if some other path already created the invoice, just resolve.
  const already = await appStorage.isInvoiceAlreadyProcessed(row.order_id);
  if (already) {
    await appStorage.resolvePending(row.id, "resolved");
    return { ok: true };
  }

  let normalized: Normalized;
  try {
    normalized = JSON.parse(row.normalized_json) as Normalized;
  } catch (e: any) {
    return { ok: false, error: `Corrupted normalized payload: ${e.message}` };
  }

  const builder = new IxBuilder(config);
  let build: { invoice: any; requestTaxExemptionReason: boolean };
  if (disposition === "apply") {
    build = builder.buildReverseChargeInvoice(normalized, row.country_code, row.vat_id);
  } else {
    build = builder.createInvoiceFromNormalizedOrder(normalized);
  }

  const ixHeaders = {
    "x-account-name": config.ix_account_name!,
    "x-api-key": config.ix_api_key!,
    "x-env": config.ix_environment === "production" ? "prod" as const : "dev" as const,
  };

  const res = await IxApi.v2.documents.post({
    headers: ixHeaders,
    body: {
      data: build.invoice,
      type: config.ix_document_type === "invoice_receipt" ? "invoice_receipt" : "invoice",
    },
    query: { resolvers: "on_tax_fallback_search_tax_by_value" },
  });

  const invoiceId = res.data?.data?.id;
  if (!invoiceId) {
    return { ok: false, error: "IX create returned no id" };
  }

  await appStorage.saveProcessedInvoice(row.order_id, String(invoiceId));
  await appStorage.resolvePending(row.id, disposition === "apply" ? "approved" : "rejected");
  await appStorage.saveLog({
    shopify_domain: row.shopify_domain,
    topic: row.webhook_topic,
    payload: JSON.stringify({ orderId: row.order_id, disposition }),
    response: `Deferred invoice created via ${disposition}`,
    status: 200,
  });

  return { ok: true, invoiceId: String(invoiceId) };
}

export async function runViesRetry(env: Env): Promise<{ retried: number; resolved: number; incidents: number; deferred: number }> {
  const summary = { retried: 0, resolved: 0, incidents: 0, deferred: 0 };

  // Pass 1: retry pending rows that have hit their next_retry_at.
  const rootStorage = new AppStorage(env);
  const rows = await rootStorage.getPendingForRetry(50);
  if (rows.length > 0) {
    const viesChecker = makeViesChecker(env.INVOICE_KV);
    for (const row of rows) {
      summary.retried++;
      const res = await viesChecker(row.country_code, row.vat_id);
      if (res === true) {
        const out = await submitInvoiceForPendingRow(env, row, "apply");
        if (out.ok) summary.resolved++;
        else await markRowError(env, row, out.error ?? "submit failed");
      } else if (res === false) {
        const out = await submitInvoiceForPendingRow(env, row, "reject");
        if (out.ok) summary.resolved++;
        else await markRowError(env, row, out.error ?? "submit failed");
      } else {
        // Still unknown — bump attempts + schedule next retry.
        const nextAttempt = row.attempts + 1;
        const backoffIdx = Math.min(nextAttempt - 1, RETRY_BACKOFF_MS.length - 1);
        const nextRetryAt = new Date(Date.now() + RETRY_BACKOFF_MS[backoffIdx]).toISOString();
        const storage = new AppStorage(env, row.shopify_domain, row.user_id);
        await storage.markPendingAttempt(row.id, nextAttempt, nextRetryAt, "VIES unknown (timeout/5xx)");
        summary.deferred++;
      }
    }
  }

  // Pass 2: rows that have exhausted retries but haven't opened an incident yet.
  const needsIncident = await rootStorage.getPendingNeedingIncident(50);
  for (const row of needsIncident) {
    const storage = new AppStorage(env, row.shopify_domain, row.user_id);
    const config = await storage.loadConfig();
    if (!config) continue;
    let orderNumber: string | number = row.order_id;
    try {
      const n = JSON.parse(row.normalized_json) as Normalized;
      orderNumber = n.order?.order_number ?? row.order_id;
    } catch { /* ignore */ }

    await reportIncident(env, {
      user_id: config.user_id,
      severity: "warning",
      kind: "vies_unconfirmed",
      summary: `VIES inacessível para VAT ${row.country_code}${row.vat_id} (order #${orderNumber}). Validação manual necessária.`,
      detail: {
        pendingId: row.id,
        orderId: row.order_id,
        vatId: row.vat_id,
        countryCode: row.country_code,
        viesValidationUrl: "https://viesvalidation.com/pt/",
      },
      affected_ids: [String(row.order_id)],
      connection_label: "shopify → invoicexpress",
      bucket: "daily",
    });

    await storage.attachPendingIncident(row.id, row.id);
    summary.incidents++;
  }

  return summary;
}

async function markRowError(env: Env, row: PendingReverseChargeRow, err: string) {
  const storage = new AppStorage(env, row.shopify_domain, row.user_id);
  const nextAttempt = row.attempts + 1;
  const backoffIdx = Math.min(nextAttempt - 1, RETRY_BACKOFF_MS.length - 1);
  const nextRetryAt = new Date(Date.now() + RETRY_BACKOFF_MS[backoffIdx]).toISOString();
  await storage.markPendingAttempt(row.id, nextAttempt, nextRetryAt, err);
}
