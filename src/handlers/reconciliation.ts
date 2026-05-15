import type { Env } from "../env";
import type { IRequestConfig } from "../storage";
import { AppStorage } from "../storage";
import { IxApi } from "../api/ix";
import { scoreHeuristicMatch } from "./reconciliation-score";

export interface ReconciliationRow {
  order: {
    id: string;
    order_number: number;
    name: string;
    total: number;
    paid_at: string;
    customer_name: string | null;
    email: string | null;
    permalink: string;
  };
  match: {
    type: "exact" | "approved" | "heuristic" | "not_needed" | "none";
    confidence: number;
    reason?: string;
  };
  invoice: {
    id: string;
    reference: string | null;
    status: string | null;
    total: number | null;
    date: string | null;
    permalink: string | null;
    pdf_url: string | null;
    client_name: string | null;
  } | null;
  candidates: Array<{
    id: string;
    reference: string | null;
    total: number;
    date: string;
    client_name: string | null;
    confidence: number;
    reason: string;
  }>;
}

interface InvoiceMeta {
  id: string;
  reference: string | null;
  status: string | null;
  total: number;
  date: string;
  permalink: string | null;
  pdf_url: string | null;
  client_name: string | null;
  order_id_link: string | null; // shopify order id this invoice maps to (from processed_orders)
}

async function fetchShopifyOrdersPaginated(config: IRequestConfig, from: string, to: string): Promise<any[]> {
  const all: any[] = [];
  const apiVersion = config.shopify_api_version ?? "2026-01";
  let url: string | null = `https://${config.shopify_domain}/admin/api/${apiVersion}/orders.json?processed_at_min=${encodeURIComponent(from)}&processed_at_max=${encodeURIComponent(to)}&status=any&financial_status=paid&limit=250`;
  while (url) {
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": config.shopify_token!, "Accept": "application/json" } });
    if (!res.ok) throw new Error(`Shopify ${res.status}: ${await res.text()}`);
    const data = await res.json() as { orders: any[] };
    all.push(...data.orders);
    const linkHeader = res.headers.get("Link");
    url = null;
    if (linkHeader) {
      const m = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (m) url = m[1];
    }
  }
  return all;
}

async function fetchInvoiceMeta(
  config: IRequestConfig,
  invoiceId: string,
  orderId: string
): Promise<InvoiceMeta | null> {
  const ixHeaders = {
    "x-account-name": config.ix_account_name!,
    "x-api-key": config.ix_api_key!,
    "x-env": config.ix_environment === "production" ? "prod" as const : "dev" as const,
  };
  try {
    const { data, error } = await IxApi.v2.documents.byId.get({
      headers: ixHeaders,
      path: { id: Number(invoiceId) },
    });
    if (error || !data?.data) return null;
    const d: any = data.data;
    return {
      id: String(d.id ?? invoiceId),
      reference: d.reference ?? null,
      status: d.status ?? d.state ?? null,
      total: Number(d.total ?? d.sum ?? 0),
      date: d.date ?? d.created_at ?? "",
      permalink: d.permalink ?? d.public_link ?? null,
      pdf_url: d.permalink_pdf ?? null,
      client_name: d.client?.name ?? null,
      order_id_link: orderId,
    };
  } catch (e) {
    console.error(`[Rioko] fetchInvoiceMeta failed for ${invoiceId}:`, e);
    return null;
  }
}

export async function getReconciliation(env: Env, config: IRequestConfig, from: string, to: string) {
  const appStorage = new AppStorage(env, config.shopify_domain!);

  // 1. Paid orders from Shopify
  const orders = await fetchShopifyOrdersPaginated(config, from, to);
  const orderIds = orders.map(o => String(o.id));

  // 2. Map order → invoice_id from DB
  const orderToInvoice = await appStorage.getProcessedInvoicesByOrderIds(orderIds);

  // 3. Overrides (manual matches + decisions)
  const { matches: manualMatches, decisions } = await appStorage.getReconciliationOverrides(orderIds);

  // 4. Manual override invoice IDs supplement automatic mapping
  for (const [orderId, m] of manualMatches.entries()) {
    if (!orderToInvoice.has(orderId)) orderToInvoice.set(orderId, m.invoice_id);
  }

  // 5. Fetch invoice metadata in parallel (capped concurrency by JS event loop)
  const invoiceEntries = Array.from(orderToInvoice.entries());
  const invoiceMetas = await Promise.all(
    invoiceEntries.map(([orderId, invoiceId]) => fetchInvoiceMeta(config, invoiceId, orderId))
  );
  const invoicesByOrderId = new Map<string, InvoiceMeta>();
  const allInvoiceMetas: InvoiceMeta[] = [];
  for (let i = 0; i < invoiceEntries.length; i++) {
    const meta = invoiceMetas[i];
    if (meta) {
      invoicesByOrderId.set(invoiceEntries[i][0], meta);
      allInvoiceMetas.push(meta);
    }
  }

  // 6. Build rows
  const shopDomain = config.shopify_domain!;
  const rows: ReconciliationRow[] = orders.map(order => {
    const orderId = String(order.id);
    const totalNum = parseFloat(order.total_price ?? "0");
    const customerName = order.customer
      ? `${order.customer.first_name ?? ""} ${order.customer.last_name ?? ""}`.trim() || null
      : null;
    const orderBlock = {
      id: orderId,
      order_number: order.order_number,
      name: order.name,
      total: totalNum,
      paid_at: order.processed_at ?? order.created_at,
      customer_name: customerName,
      email: order.customer?.email ?? order.email ?? null,
      permalink: `https://${shopDomain.replace(".myshopify.com", "")}.myshopify.com/admin/orders/${orderId}`,
    };

    // Decision override wins
    const decision = decisions.get(orderId);
    if (decision?.decision === "NOT_NEEDED") {
      return {
        order: orderBlock,
        match: { type: "not_needed", confidence: 0, reason: decision.reason ?? undefined },
        invoice: null,
        candidates: [],
      };
    }

    const inv = invoicesByOrderId.get(orderId);
    const manualMatch = manualMatches.get(orderId);

    if (inv) {
      const expectedRef = `Order #${order.order_number}`;
      const isExact = inv.reference === expectedRef;
      const type: ReconciliationRow["match"]["type"] = manualMatch
        ? "approved"
        : isExact ? "exact" : "heuristic";
      return {
        order: orderBlock,
        match: { type, confidence: type === "heuristic" ? 80 : 100 },
        invoice: {
          id: inv.id,
          reference: inv.reference,
          status: inv.status,
          total: inv.total,
          date: inv.date,
          permalink: inv.permalink,
          pdf_url: inv.pdf_url,
          client_name: inv.client_name,
        },
        candidates: [],
      };
    }

    // Heuristic: score against the invoice pool we already fetched
    const candidates = allInvoiceMetas
      .filter(im => im.order_id_link !== orderId) // not already linked elsewhere is OK; we still rank
      .map(im => {
        const { score, reasons } = scoreHeuristicMatch(
          { amount: totalNum, date: orderBlock.paid_at, customerName, reference: `${order.order_number}` },
          { amount: im.total, date: im.date, clientName: im.client_name, reference: im.reference }
        );
        return { im, score, reasons };
      })
      .filter(c => c.score >= 30)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    return {
      order: orderBlock,
      match: candidates.length > 0
        ? { type: "heuristic", confidence: candidates[0].score, reason: candidates[0].reasons.join(" · ") }
        : { type: "none", confidence: 0 },
      invoice: null,
      candidates: candidates.map(c => ({
        id: c.im.id,
        reference: c.im.reference,
        total: c.im.total,
        date: c.im.date,
        client_name: c.im.client_name,
        confidence: c.score,
        reason: c.reasons.join(" · "),
      })),
    };
  });

  // Sort newest first
  rows.sort((a, b) => Date.parse(b.order.paid_at) - Date.parse(a.order.paid_at));

  return {
    from,
    to,
    total_orders: rows.length,
    summary: {
      exact: rows.filter(r => r.match.type === "exact").length,
      approved: rows.filter(r => r.match.type === "approved").length,
      heuristic: rows.filter(r => r.match.type === "heuristic").length,
      none: rows.filter(r => r.match.type === "none").length,
      not_needed: rows.filter(r => r.match.type === "not_needed").length,
    },
    rows,
  };
}

export async function approveReconciliationMatch(
  env: Env,
  config: IRequestConfig,
  orderId: string,
  invoiceId: string,
  approvedBy: string | null
) {
  const appStorage = new AppStorage(env, config.shopify_domain!);
  await appStorage.upsertReconciliationMatch(orderId, invoiceId, approvedBy);
  return { ok: true, order_id: orderId, invoice_id: invoiceId };
}

export async function revertReconciliationMatch(env: Env, config: IRequestConfig, orderId: string) {
  const appStorage = new AppStorage(env, config.shopify_domain!);
  await appStorage.deleteReconciliationMatch(orderId);
  return { ok: true, order_id: orderId };
}

export async function setReconciliationDecisionAction(
  env: Env,
  config: IRequestConfig,
  orderId: string,
  decision: string | null,
  reason: string | null,
  decidedBy: string | null
) {
  const appStorage = new AppStorage(env, config.shopify_domain!);
  if (decision === null) {
    await appStorage.clearReconciliationDecision(orderId);
    return { ok: true, order_id: orderId, cleared: true };
  }
  await appStorage.setReconciliationDecision(orderId, decision, reason, decidedBy);
  return { ok: true, order_id: orderId, decision };
}

export async function getShopForUser(env: Env, userId: string): Promise<{ shopify_domain: string | null }> {
  const appStorage = new AppStorage(env);
  const domain = await appStorage.getShopByUserId(userId);
  return { shopify_domain: domain };
}
