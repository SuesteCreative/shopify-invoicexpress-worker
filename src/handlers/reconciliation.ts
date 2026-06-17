import type { Env } from "../env";
import type { IRequestConfig } from "../storage";
import { AppStorage } from "../storage";
import { IxApi } from "../api/ix";
import { ixCall } from "../ix/ix-call";
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
    /** Shopify financial_status ("paid", "pending", "authorized", …). Lets the
     * UI show a held pending order as "Pendente" instead of assuming "Pago". */
    financial_status: string | null;
  };
  match: {
    type: "exact" | "approved" | "heuristic" | "not_needed" | "none" | "pending";
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
    /** True when we KNOW an invoice was issued (we hold its id) but couldn't
     * load its details from InvoiceXpress this round (proxy slow/over capacity).
     * The merchant must see "fatura emitida (detalhe indisponível)", NEVER the
     * alarming "Sem fatura emitida" — a transient read failure is not a missing
     * invoice. invoice_id is only ever written after a successful IX create. */
    meta_unavailable?: boolean;
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

async function fetchShopifyOrdersPaginated(
  config: IRequestConfig,
  from: string,
  to: string,
  opts?: { financialStatus?: string; dateField?: "processed_at" | "created_at" },
): Promise<any[]> {
  const all: any[] = [];
  const apiVersion = config.shopify_api_version ?? "2026-01";
  const financialStatus = opts?.financialStatus ?? "paid";
  // Paid orders carry a processed_at; pending (unpaid Multibanco/transfer) ones
  // usually don't, so they must be windowed by created_at or they'd never match.
  const dateField = opts?.dateField ?? "processed_at";
  let url: string | null = `https://${config.shopify_domain}/admin/api/${apiVersion}/orders.json?${dateField}_min=${encodeURIComponent(from)}&${dateField}_max=${encodeURIComponent(to)}&status=any&financial_status=${encodeURIComponent(financialStatus)}&limit=250`;
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Map over items with a bounded number of in-flight promises. The IX proxy
 * (ix-proxy.kapta.app) sits on shared hosting and collapses under a burst of
 * ~200 simultaneous reads — a single reconciliation fired one fetch per invoice
 * via Promise.all with NO cap, so a 200-order shop hammered the proxy with 200
 * parallel GETs. Half timed out, their metas came back null, and every one of
 * those *issued* invoices was then rendered as "Sem fatura emitida" — the bug
 * that made a merchant think dozens of real invoices had vanished. Capping the
 * concurrency keeps the proxy responsive so the reads actually succeed. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

// The IX proxy (ix-proxy.kapta.app) is shared hosting and stalls under load.
// Earlier this used the generated SDK, but the SDK doesn't honour an abort
// signal — so when a fetch hung, racing it with a timeout returned early yet left
// the underlying request IN-FLIGHT, which kept the whole worker alive until it
// hit the ~30s wall-clock limit and Cloudflare killed it (a 500 — the page
// failing to load entirely). We now use raw `fetch` with a real AbortController
// so a hung read is actually cancelled at `budget`, and the caller renders the
// invoice as issued-but-detail-unavailable rather than "missing".
const IX_PROXY_BASE = "https://ix-proxy.kapta.app";

async function fetchInvoiceMeta(
  config: IRequestConfig,
  invoiceId: string,
  orderId: string,
  deadline?: number,
): Promise<InvoiceMeta | null> {
  const ixHeaders = {
    "x-account-name": config.ix_account_name!,
    "x-api-key": config.ix_api_key!,
    "x-env": config.ix_environment === "production" ? "prod" : "dev",
    "Accept": "application/json",
  };
  const PER_ATTEMPT_MS = 5000;
  for (let attempt = 0; attempt < 3; attempt++) {
    // Bounded-load: once the page's overall meta budget is spent, stop hitting
    // the proxy entirely so the request always returns inside the worker limit.
    if (deadline && Date.now() >= deadline) return null;
    const budget = deadline ? Math.max(500, Math.min(PER_ATTEMPT_MS, deadline - Date.now())) : PER_ATTEMPT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      const res = await fetch(`${IX_PROXY_BASE}/v2/documents/${Number(invoiceId)}`, {
        headers: ixHeaders,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        if (res.status === 404) return null; // genuine 404 — invoice not at IX
        if (attempt < 2 && (!deadline || Date.now() < deadline)) { await sleep(300 * (attempt + 1)); continue; }
        return null;
      }
      const j: any = await res.json().catch(() => null);
      const d: any = j?.data;
      if (!d) return null;
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
      clearTimeout(timer);
      // AbortError (our timeout) or a network blip — retry within budget, else
      // give up on the detail and keep the page responsive.
      if (attempt < 2 && (!deadline || Date.now() < deadline)) { await sleep(200); continue; }
      return null;
    }
  }
  return null;
}

export async function getReconciliation(env: Env, config: IRequestConfig, from: string, to: string) {
  const appStorage = new AppStorage(env, config.shopify_domain!);

  // 1. Orders from Shopify. Always the paid set (matched against IX invoices).
  //    When the shop holds invoices until payment (only_invoice_when_paid), also
  //    pull pending orders so the operator sees what is deliberately NOT yet
  //    invoiced ("fatura não por emitir"). Pending orders rarely carry a
  //    processed_at, so that set is windowed by created_at instead.
  const paidOrders = await fetchShopifyOrdersPaginated(config, from, to);
  let orders = paidOrders;
  if (config.only_invoice_when_paid === 1) {
    const pendingOrders = await fetchShopifyOrdersPaginated(config, from, to, { financialStatus: "pending", dateField: "created_at" });
    const seen = new Set(paidOrders.map(o => String(o.id)));
    orders = paidOrders.concat(pendingOrders.filter(o => !seen.has(String(o.id))));
  }
  const orderIds = orders.map(o => String(o.id));

  // 2. Map order → invoice_id from DB
  const orderToInvoice = await appStorage.getProcessedInvoicesByOrderIds(orderIds);

  // 3. Overrides (manual matches + decisions)
  const { matches: manualMatches, decisions } = await appStorage.getReconciliationOverrides(orderIds);

  // 4. Manual override invoice IDs supplement automatic mapping
  for (const [orderId, m] of manualMatches.entries()) {
    if (!orderToInvoice.has(orderId)) orderToInvoice.set(orderId, m.invoice_id);
  }

  // 5. Resolve invoice metadata: KV cache FIRST (so we stop hammering the IX
  //    proxy with one read per invoice on every load — the load that overwhelmed
  //    the proxy and produced the phantom "Sem fatura"). On a cache miss we fetch
  //    from IX with bounded concurrency + retry (as before) and write the result
  //    back to KV, so the cache warms itself and subsequent loads are proxy-free.
  // Overall budget for the cold (cache-miss) proxy reads. Cached invoices return
  // instantly; only misses fetch. Once this deadline passes, remaining misses are
  // skipped and rendered as "detalhe indisponível" so the page always returns
  // well inside the worker's wall-clock limit instead of 500-ing on a slow proxy.
  const metaDeadline = Date.now() + 12_000;
  const invoiceEntries = Array.from(orderToInvoice.entries());
  const cachedMetas = await appStorage.getCachedInvoiceMetas(invoiceEntries.map(([, invoiceId]) => invoiceId));
  const invoiceMetas = await mapWithConcurrency(
    invoiceEntries, 6,
    async ([orderId, invoiceId]) => {
      const cached = cachedMetas.get(String(invoiceId));
      if (cached) return { ...cached, order_id_link: orderId } as InvoiceMeta;
      const meta = await fetchInvoiceMeta(config, invoiceId, orderId, metaDeadline);
      if (meta) {
        const { order_id_link, ...store } = meta;
        await appStorage.cacheInvoiceMeta(invoiceId, store);
      }
      return meta;
    }
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
      financial_status: order.financial_status ?? null,
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

    // We HOLD an invoice_id for this order (DB or manual match) but its metadata
    // couldn't be read from IX this round (proxy slow/over capacity). The invoice
    // exists — invoice_id is only ever persisted after a successful IX create —
    // so we MUST NOT fall through to "Sem fatura". Render it as issued, with the
    // id we have, flagged meta_unavailable so the UI shows "detalhe indisponível"
    // instead of a false "missing invoice" alarm. Also skip the heuristic: never
    // suggest matching an already-invoiced order to some other invoice.
    const knownInvoiceId = orderToInvoice.get(orderId);
    if (knownInvoiceId) {
      return {
        order: orderBlock,
        match: {
          type: manualMatch ? "approved" : "exact",
          confidence: 100,
          reason: "Fatura emitida — detalhe do InvoiceXpress indisponível de momento",
        },
        invoice: {
          id: knownInvoiceId,
          reference: null,
          status: null,
          total: null,
          date: null,
          permalink: null,
          pdf_url: null,
          client_name: null,
          meta_unavailable: true,
        },
        candidates: [],
      };
    }

    // Pending order with no invoice = intentionally held until payment confirms
    // (only_invoice_when_paid). NOT an alarm ("Sem fatura") and NOT a heuristic
    // candidate — it's correctly waiting. Give it its own state so the operator
    // sees it's tracked, not lost. (Reached only when no invoice resolved above;
    // a pending order that WAS invoiced still renders via the inv branch.)
    if (String(order.financial_status) !== "paid") {
      return {
        order: orderBlock,
        match: { type: "pending", confidence: 0, reason: "Aguarda confirmação de pagamento no Shopify — fatura não por emitir" },
        invoice: null,
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

  // 6b. Recover manual / mapping-lost invoices: for orders still showing "none",
  // ask IX whether a document with our "Order #N" reference exists. This catches
  // (a) invoices the system created but whose DB mapping was lost (e.g. a create
  // that timed out after IX had already issued it — see #1054), and (b) manual
  // invoices that followed the reference convention. NOTE: it can NOT find manual
  // invoices with arbitrary references — the IX API has no list endpoint. Bounded
  // (capped concurrency + ixCall timeout) and cached per reference (id or "MISS",
  // 1h TTL) so repeated loads don't re-hammer the proxy.
  const noneRows = rows.filter(r => r.match.type === "none");
  if (noneRows.length > 0) {
    const ixHeaders = {
      "x-account-name": config.ix_account_name!,
      "x-api-key": config.ix_api_key!,
      "x-env": config.ix_environment === "production" ? "prod" as const : "dev" as const,
    };
    const refOf = (r: ReconciliationRow) => `Order #${r.order.order_number}`;
    const account = config.ix_account_name!;
    const refDeadline = Date.now() + 8_000; // bound the recovery phase too
    const cachedRefs = await appStorage.getCachedRefLookups(account, noneRows.map(refOf));
    await mapWithConcurrency(noneRows, 4, async (row) => {
      if (Date.now() >= refDeadline) return; // budget spent — leave as-is, don't hang the worker
      const ref = refOf(row);
      let invoiceId: string | null = null;
      const cached = cachedRefs.get(ref);
      if (cached === "MISS") return;
      if (cached) invoiceId = cached;
      else {
        // Raw fetch with a REAL AbortController. The old path used ixCall (SDK +
        // timeout-race), which (a) doesn't abort, so a hung ref lookup orphaned a
        // fetch and ran the worker into its limit, and (b) THREW on exhaustion —
        // a single uninvoiced order with a slow proxy ref-lookup crashed the whole
        // page (500). Now: bounded, single attempt, and a failure just leaves the
        // row as "none" — the page always renders.
        try {
          const budget = Math.max(500, Math.min(4000, refDeadline - Date.now()));
          const c = new AbortController();
          const t = setTimeout(() => c.abort(), budget);
          const r = await fetch(`${IX_PROXY_BASE}/v2/documents/reference`, {
            method: "POST",
            headers: { ...ixHeaders, "Accept": "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ reference: ref }),
            signal: c.signal,
          });
          clearTimeout(t);
          const j: any = r.ok ? await r.json().catch(() => null) : null;
          invoiceId = j?.data?.data?.id ? String(j.data.data.id) : (j?.data?.id ? String(j.data.id) : null);
          await appStorage.cacheRefLookup(account, ref, invoiceId ?? "MISS");
        } catch {
          return; // proxy slow/aborted — leave as "none", never crash the page
        }
      }
      if (!invoiceId) return;
      const meta = await fetchInvoiceMeta(config, invoiceId, row.order.id, refDeadline);
      if (!meta) return;
      const { order_id_link, ...store } = meta;
      await appStorage.cacheInvoiceMeta(invoiceId, store);
      row.match = { type: "heuristic", confidence: 90, reason: "Encontrada no InvoiceXpress por referência (não mapeada na BD)" };
      row.invoice = {
        id: meta.id, reference: meta.reference, status: meta.status, total: meta.total,
        date: meta.date, permalink: meta.permalink, pdf_url: meta.pdf_url, client_name: meta.client_name,
      };
      row.candidates = [];
    });
  }

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
      pending: rows.filter(r => r.match.type === "pending").length,
      // Issued invoices we couldn't read from IX this round (subset of exact/
      // approved). Lets ops see "verification degraded" vs trusting the page blindly.
      unverified: rows.filter(r => r.invoice?.meta_unavailable).length,
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
