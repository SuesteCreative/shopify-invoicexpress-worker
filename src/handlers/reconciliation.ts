import type { Env } from "../env";
import type { IRequestConfig, SourceKind, DestinationKind } from "../storage";
import { AppStorage } from "../storage";
import type { AdapterCtx } from "../adapters/types";
import { getMoloniCfg, getAccessToken, moloniCall } from "../adapters/destinations/moloni-destination";
import { scoreHeuristicMatch } from "./reconciliation-score";

// The left side of a reconciliation row, normalized across sources (Shopify
// orders, Lodgify bookings, …). Each source fetcher maps its native records
// into this shape so the row-building core below is source-agnostic.
export interface ReconOrder {
  id: string;
  order_number: number;
  name: string;
  total: number;
  paid_at: string;
  customer_name: string | null;
  email: string | null;
  permalink: string;
  /** Payment status normalized to the Shopify enum ("paid"|"pending"|…). Lets
   * the UI hold an unpaid order/booking as "Pendente" instead of "Pago". */
  financial_status: string | null;
  /** Sales channel / OTA the booking came through (Lodgify `source`, e.g.
   * "BookingCom", "Airbnb", "Manual", "Direct"). Null for non-Lodgify sources. */
  channel?: string | null;
}

export interface ReconciliationRow {
  order: ReconOrder;
  match: {
    type: "exact" | "approved" | "heuristic" | "not_needed" | "none" | "pending";
    confidence: number;
    reason?: string;
  };
  invoice: {
    id: string;
    reference: string | null;
    /** Human-facing document number. For Moloni: the real fatura number once
     * finalized (e.g. "RVFR 5"), or "#<document_id>" while still a draft
     * (Moloni assigns number=-1 to drafts). Null for destinations that surface
     * the number via `reference` already (InvoiceXpress). */
    number: string | null;
    status: string | null;
    total: number | null;
    date: string | null;
    permalink: string | null;
    pdf_url: string | null;
    client_name: string | null;
    /** True when we KNOW an invoice was issued (we hold its id) but couldn't
     * load its details from the destination this round (proxy slow/over capacity).
     * The merchant must see "fatura emitida (detalhe indisponível)", NEVER the
     * alarming "Sem fatura emitida" — a transient read failure is not a missing
     * invoice. invoice_id is only ever written after a successful create. */
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
  number: string | null; // human doc number (finalized) or "#<id>" (draft); null for IX
  status: string | null;
  total: number;
  date: string;
  permalink: string | null;
  pdf_url: string | null;
  client_name: string | null;
  order_id_link: string | null; // source order/booking id this invoice maps to
}

// Everything a reconciliation run needs, resolved once from either a Shopify
// shop domain or a user's active `connections` row. Drives which source list
// to fetch and which destination to read invoice metadata from.
export interface ReconContext {
  source: SourceKind;
  destination: DestinationKind;
  sourceConfig: Record<string, any>;
  destinationConfig: Record<string, any>;
  config: IRequestConfig;
  userId: string | null;
  /** AppStorage key the override tables (match/decision) are scoped by:
   *  the Shopify domain for Shopify, else `u:<userId>` for connection-based
   *  sources that have no domain. */
  scope: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function numericFromId(id: string | number): number {
  const digits = String(id).replace(/\D/g, "").slice(-12);
  return Number(digits) || 0;
}

function dateOnly(input: string): string {
  const m = String(input ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

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

// ── Source fetchers (left side) ───────────────────────────────────────────────

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

async function fetchShopifyReconOrders(ctx: ReconContext, from: string, to: string): Promise<ReconOrder[]> {
  const config = ctx.config;
  const paidOrders = await fetchShopifyOrdersPaginated(config, from, to);
  let orders = paidOrders;
  // When the shop holds invoices until payment (only_invoice_when_paid), also
  // pull pending orders so the operator sees what is deliberately NOT yet
  // invoiced ("fatura não por emitir"). Pending orders rarely carry a
  // processed_at, so that set is windowed by created_at instead.
  if (config.only_invoice_when_paid === 1) {
    const pendingOrders = await fetchShopifyOrdersPaginated(config, from, to, { financialStatus: "pending", dateField: "created_at" });
    const seen = new Set(paidOrders.map(o => String(o.id)));
    orders = paidOrders.concat(pendingOrders.filter(o => !seen.has(String(o.id))));
  }
  const shopDomain = config.shopify_domain!;
  return orders.map((order) => {
    const orderId = String(order.id);
    const customerName = order.customer
      ? `${order.customer.first_name ?? ""} ${order.customer.last_name ?? ""}`.trim() || null
      : null;
    return {
      id: orderId,
      order_number: order.order_number,
      name: order.name,
      total: parseFloat(order.total_price ?? "0"),
      paid_at: order.processed_at ?? order.created_at,
      customer_name: customerName,
      email: order.customer?.email ?? order.email ?? null,
      permalink: `https://${shopDomain.replace(".myshopify.com", "")}.myshopify.com/admin/orders/${orderId}`,
      financial_status: order.financial_status ?? null,
    };
  });
}

// Lodgify bookings for the window. A booking is included if it was MADE
// (created_at) in [from, to] OR its stay (arrival) falls in [from, to]. Created
// alone would hide bookings made earlier that arrive now; arrival alone hides
// bookings just made for a future stay — the common PMS case, and what the
// operator expects to see right after a booking comes in. We list via the v2
// endpoint (stayFilter=All) and window locally so correctness never depends on
// the server date-param contract. Payment ("paid" iff amount_due≈0) is
// orthogonal — unpaid bookings still show (as "pending"). Declined/cancelled
// are omitted (cancellations, not sales).
async function fetchLodgifyReconOrders(ctx: ReconContext, from: string, to: string): Promise<ReconOrder[]> {
  const apiKey = ctx.sourceConfig?.api_key;
  if (!apiKey) throw new Error("Lodgify api_key missing from connection sourceConfig");
  const fromYmd = dateOnly(from);
  const toYmd = dateOnly(to);

  const items: any[] = [];
  const size = 50;
  const headers = { "X-ApiKey": apiKey, "Accept": "application/json" };
  for (let page = 1; page <= 40; page++) {
    // stayFilter=All (verified working) + local arrival-window filter below.
    // ArrivalDate matches a single exact `stayFilterDate`, so it can't express
    // the [from,to] range this reconciliation needs; All + local guard does.
    const qs = new URLSearchParams({
      stayFilter: "All",
      page: String(page),
      size: String(size),
      includeCount: "false",
    });
    const url = `https://api.lodgify.com/v2/reservations/bookings?${qs.toString()}`;

    // Lodgify rate-limits this (unregistered) integration and returns 429 on a
    // burst of page reads. Retry with Retry-After backoff, then DEGRADE
    // GRACEFULLY: return the bookings gathered so far instead of throwing —
    // a partial reconciliation list is far better than a dead page.
    let pageItems: any[] | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(url, { headers });
      if (res.ok) {
        const data: any = await res.json().catch(() => null);
        pageItems = Array.isArray(data?.items) ? data.items
          : Array.isArray(data?.bookings) ? data.bookings
          : Array.isArray(data) ? data
          : [];
        break;
      }
      if (res.status === 429) {
        const ra = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 6000) : 700 * (attempt + 1);
        await sleep(waitMs);
        continue;
      }
      console.error(`[Recon] Lodgify list page ${page} → ${res.status} ${res.statusText}`);
      break;
    }
    if (pageItems == null) break; // 429-exhausted or non-200 — use what we have
    items.push(...pageItems);
    if (pageItems.length < size) break;
    // Pace subsequent pages to avoid re-tripping the rate limit.
    await sleep(250);
  }

  const rows: ReconOrder[] = [];
  for (const b of items) {
    const status = String(b.status ?? b.state ?? "").toLowerCase();
    if (status === "declined" || status === "cancelled" || status === "canceled") continue;
    const arrival = dateOnly(b.arrival ?? b.date_arrival ?? "");
    const created = dateOnly(b.created_at ?? b.date_created ?? "");
    // Include if made in-window OR arriving in-window (see fn comment).
    const inCreated = !!created && (!fromYmd || created >= fromYmd) && (!toYmd || created <= toYmd);
    const inArrival = !!arrival && (!fromYmd || arrival >= fromYmd) && (!toYmd || arrival <= toYmd);
    if (!inCreated && !inArrival) continue;

    const id = String(b.id ?? b.booking_id ?? b.reservation_id ?? "");
    if (!id) continue;
    const departure = dateOnly(b.departure ?? b.date_departure ?? "");
    const totalRaw = b.total_amount?.amount ?? b.total_amount ?? b.amount?.amount ?? b.amount ?? b.total ?? 0;
    const guestName = b.guest?.name ?? b.guest_name ?? b.name ?? null;
    const guestEmail = b.guest?.email ?? b.email ?? null;
    // Payment status mirrors the poll's invoice gate: a booking is "paid" once
    // it's settled in Lodgify (amount_due≈0) — whether captured through Lodgify
    // or marked paid by staff for an OTA stay. Positive balance ⇒ "pending"
    // (rendered as "Fatura não por emitir"). Fall back to booked-status only when
    // the balance field is absent.
    const amountDue = Number(b.amount_due ?? b.balance_due ?? NaN);
    const financial = Number.isFinite(amountDue)
      ? (amountDue <= 0.01 ? "paid" : "pending")
      : (status === "booked" ? "paid" : "pending");
    rows.push({
      id,
      order_number: numericFromId(id),
      name: `LOD-${id}`,
      total: Number(totalRaw) || 0,
      // Sort/display by booking date so freshly-made bookings surface at the top.
      paid_at: (b.created_at ? String(b.created_at) : null) ?? (arrival ? `${arrival}T12:00:00Z` : new Date().toISOString()),
      customer_name: guestName ? String(guestName) : null,
      email: guestEmail ? String(guestEmail) : null,
      // Best-effort deep link to the booking in the Lodgify owner app. If the
      // path shape changes tenant-side, adjust here; it is display-only.
      permalink: `https://app.lodgify.com/#/reservations/bookings/${id}`,
      financial_status: financial,
      channel: b.source ? String(b.source) : null,
    });
  }
  return rows;
}

async function getSourceOrders(ctx: ReconContext, from: string, to: string): Promise<ReconOrder[]> {
  switch (ctx.source) {
    case "lodgify": return fetchLodgifyReconOrders(ctx, from, to);
    case "shopify": return fetchShopifyReconOrders(ctx, from, to);
    default:
      // Stripe/EuPago reconciliation not implemented yet — no left-side list.
      return [];
  }
}

// ── Invoice-meta fetchers (right side) ────────────────────────────────────────

interface MetaFetcher {
  /** KV cache namespace for invoice metadata (per destination). */
  metaNs: string;
  /** KV cache namespace + account for the reference-recovery lookup. */
  refNs: string;
  refAccount: string;
  fetchMeta(invoiceId: string, orderId: string, deadline?: number): Promise<InvoiceMeta | null>;
  /** Resolve an invoice id from our "Order #N" reference, or null on miss. */
  findByReference(reference: string, deadline?: number): Promise<string | null>;
}

// The IX proxy (ix-proxy.kapta.app) is shared hosting and stalls under load. We
// use raw `fetch` with a real AbortController so a hung read is actually
// cancelled at `budget`, and the caller renders the invoice as
// issued-but-detail-unavailable rather than "missing".
const IX_PROXY_BASE = "https://ix-proxy.kapta.app";

async function fetchIxInvoiceMeta(
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
        number: null, // IX surfaces the doc number via `reference`
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
      if (attempt < 2 && (!deadline || Date.now() < deadline)) { await sleep(200); continue; }
      return null;
    }
  }
  return null;
}

async function fetchIxByReference(config: IRequestConfig, ref: string, deadline?: number): Promise<string | null> {
  const ixHeaders = {
    "x-account-name": config.ix_account_name!,
    "x-api-key": config.ix_api_key!,
    "x-env": config.ix_environment === "production" ? "prod" as const : "dev" as const,
  };
  try {
    const budget = deadline ? Math.max(500, Math.min(4000, deadline - Date.now())) : 4000;
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
    return j?.data?.data?.id ? String(j.data.data.id) : (j?.data?.id ? String(j.data.id) : null);
  } catch {
    return null;
  }
}

// Moloni invoice metadata. Reuses the destination adapter's OAuth + call layer.
// cfg/token are resolved lazily once per run and memoized across the fetches.
function makeMoloniMetaFetcher(ctx: ReconContext): MetaFetcher {
  const ctxLike = { apiKey: "", config: ctx.config, destinationConfig: ctx.destinationConfig } as AdapterCtx;
  const docType = String(ctx.destinationConfig?.moloni_document_type ?? "invoice").toLowerCase();
  const getOnePath = docType === "invoice_receipt" ? "/invoiceReceipts/getOne/" : "/invoices/getOne/";
  const getAllPath = docType === "invoice_receipt" ? "/invoiceReceipts/getAll/" : "/invoices/getAll/";
  let creds: Promise<{ cfg: Awaited<ReturnType<typeof getMoloniCfg>>; token: string }> | null = null;
  const getCreds = () => {
    if (!creds) creds = (async () => {
      const cfg = await getMoloniCfg(ctxLike);
      const token = await getAccessToken(cfg);
      return { cfg, token };
    })();
    return creds;
  };

  const account = `moloni:${ctx.destinationConfig?.moloni_company_id ?? ctx.destinationConfig?.moloni_client_id ?? "x"}`;

  return {
    metaNs: "molmeta",
    refNs: "molref",
    refAccount: account,
    async fetchMeta(invoiceId, orderId, deadline) {
      if (deadline && Date.now() >= deadline) return null;
      try {
        const { cfg, token } = await getCreds();
        const d: any = await moloniCall(cfg, token, getOnePath, { document_id: Number(invoiceId) }, "lookup");
        if (!d || typeof d !== "object") return null;
        // Moloni names gross_value / net_value inconsistently (see moloni-api-quirks);
        // pick the larger so the total is the gross regardless of the labelling.
        const total = Math.max(Number(d.net_value ?? 0), Number(d.gross_value ?? 0)) || Number(d.total ?? 0);
        const clientName = d.entity?.name ?? d.entity_name ?? d.customer?.name ?? null;
        const isFinal = Number(d.status) === 1;
        const docId = String(d.document_id ?? invoiceId);
        // Moloni assigns number=-1 to drafts; a real sequential number only
        // exists once finalized. Show the finalized number (prefixed with the
        // document set, e.g. "RVFR 5") when available, else the internal doc id
        // "#<id>" so the draft is still identifiable in Moloni.
        const num = Number(d.number);
        const number = isFinal && Number.isFinite(num) && num > 0
          ? `${d.document_set_name ? `${d.document_set_name} ` : ""}${num}`
          : `#${docId}`;
        // Moloni exposes a shareable PDF link only for FINALIZED documents
        // (drafts have none). Best-effort: fetch it so a paid booking's invoice
        // is clickable once finalized. Failure (draft, valid:0, transient)
        // leaves the link null and the UI shows the number as plain text.
        let permalink: string | null = null;
        if (isFinal) {
          try {
            const pdf: any = await moloniCall(cfg, token, "/documents/getPDFLink/", { document_id: Number(invoiceId) }, "lookup");
            permalink = (pdf?.url ?? pdf?.link ?? null) as string | null;
          } catch { /* no public link for this document — leave null */ }
        }
        return {
          id: docId,
          reference: d.our_reference ?? null,
          number,
          status: isFinal ? "final" : "draft",
          total,
          date: dateOnly(d.date ?? "") || String(d.date ?? ""),
          permalink,
          pdf_url: permalink,
          client_name: clientName ? String(clientName) : null,
          order_id_link: orderId,
        };
      } catch {
        return null;
      }
    },
    async findByReference(reference, deadline) {
      if (deadline && Date.now() >= deadline) return null;
      try {
        const { cfg, token } = await getCreds();
        const found = await moloniCall<Array<{ document_id?: number }>>(
          cfg, token, getAllPath, { document_set_id: cfg.documentSetId, our_reference: reference }, "lookup",
        );
        const first = Array.isArray(found) ? found[0] : null;
        return first?.document_id ? String(first.document_id) : null;
      } catch {
        return null;
      }
    },
  };
}

function makeIxMetaFetcher(ctx: ReconContext): MetaFetcher {
  const config = ctx.config;
  return {
    metaNs: "ixmeta",
    refNs: "ixref",
    refAccount: config.ix_account_name ?? "ix",
    fetchMeta: (invoiceId, orderId, deadline) => fetchIxInvoiceMeta(config, invoiceId, orderId, deadline),
    findByReference: (reference, deadline) => fetchIxByReference(config, reference, deadline),
  };
}

function getMetaFetcher(ctx: ReconContext): MetaFetcher {
  switch (ctx.destination) {
    case "moloni": return makeMoloniMetaFetcher(ctx);
    case "invoicexpress": return makeIxMetaFetcher(ctx);
    default:
      // Vendus/others: no meta fetcher yet — treat every invoice as detail-unavailable.
      return {
        metaNs: `meta_${ctx.destination}`, refNs: `ref_${ctx.destination}`, refAccount: ctx.destination,
        fetchMeta: async () => null,
        findByReference: async () => null,
      };
  }
}

// ── Context resolution ────────────────────────────────────────────────────────

// Build the reconciliation context from either a Shopify shop domain (legacy,
// back-compat) or a user's active connection. Returns null when neither yields
// a usable integration.
export async function resolveReconContext(
  env: Env,
  opts: { shop?: string | null; userId?: string | null },
): Promise<ReconContext | null> {
  // Explicit Shopify shop wins (existing callers pass ?shop=).
  if (opts.shop) {
    const appStorage = new AppStorage(env, opts.shop);
    const config = await appStorage.loadConfig();
    if (!config) return null;
    return {
      source: "shopify", destination: "invoicexpress",
      sourceConfig: {}, destinationConfig: {},
      config, userId: config.user_id ?? opts.userId ?? null,
      scope: opts.shop,
    };
  }

  if (opts.userId) {
    const conn: any = await env.DB.prepare(
      `SELECT source_kind, destination_kind, source_config_json, destination_config_json
       FROM connections WHERE user_id = ? AND status = 'active'
       ORDER BY updated_at DESC LIMIT 1`
    ).bind(opts.userId).first();

    const parse = (s: string | null): Record<string, any> => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };

    if (conn) {
      const source = conn.source_kind as SourceKind;
      const destination = conn.destination_kind as DestinationKind;
      const appStorage = new AppStorage(env, null, opts.userId);
      // A Shopify connection still has a legacy integrations row; a Lodgify-only
      // user may not, so synthesize a minimal config (mirrors the webhook path).
      const config = (await appStorage.loadConfig()) ?? synthLegacyConfig(opts.userId);
      const scope = source === "shopify" && config.shopify_domain
        ? config.shopify_domain
        : `u:${opts.userId}`;
      return {
        source, destination,
        sourceConfig: parse(conn.source_config_json),
        destinationConfig: parse(conn.destination_config_json),
        config, userId: opts.userId, scope,
      };
    }

    // No connection row — fall back to legacy Shopify integration keyed by user.
    const appStorage = new AppStorage(env, null, opts.userId);
    const config = await appStorage.loadConfig();
    if (config?.shopify_domain) {
      return {
        source: "shopify", destination: "invoicexpress",
        sourceConfig: {}, destinationConfig: {},
        config, userId: opts.userId, scope: config.shopify_domain,
      };
    }
  }
  return null;
}

function synthLegacyConfig(userId: string): IRequestConfig {
  return {
    id: null, user_id: userId, shopify_domain: null,
    only_invoice_when_paid: 0,
  } as unknown as IRequestConfig;
}

// ── Core ──────────────────────────────────────────────────────────────────────

export async function getReconciliation(env: Env, ctx: ReconContext, from: string, to: string) {
  const appStorage = new AppStorage(env, ctx.scope, ctx.userId);
  const meta = getMetaFetcher(ctx);

  // 1. Orders/bookings from the source.
  const orders = await getSourceOrders(ctx, from, to);
  const orderIds = orders.map(o => o.id);

  // 2. Map order → invoice_id from DB (scoped by source to avoid id collisions).
  const orderToInvoice = await appStorage.getProcessedInvoicesByOrderIds(orderIds, ctx.source);

  // 3. Overrides (manual matches + decisions), scoped to this integration.
  const { matches: manualMatches, decisions } = await appStorage.getReconciliationOverrides(orderIds);

  // 4. Manual override invoice IDs supplement automatic mapping.
  for (const [orderId, m] of manualMatches.entries()) {
    if (!orderToInvoice.has(orderId)) orderToInvoice.set(orderId, m.invoice_id);
  }

  // 5. Resolve invoice metadata: KV cache FIRST (so we stop hammering the
  //    destination with one read per invoice on every load). On a cache miss we
  //    fetch with bounded concurrency + retry and write the result back to KV.
  const metaDeadline = Date.now() + 12_000;
  const invoiceEntries = Array.from(orderToInvoice.entries());
  const cachedMetas = await appStorage.getCachedInvoiceMetas(invoiceEntries.map(([, invoiceId]) => invoiceId), meta.metaNs);
  const invoiceMetas = await mapWithConcurrency(
    invoiceEntries, 6,
    async ([orderId, invoiceId]) => {
      const cached = cachedMetas.get(String(invoiceId));
      // Never serve OR write a cached DRAFT: its status/number/PDF link all
      // change the moment it's finalized. Caching only immutable finalized docs
      // means a manual finalize in Moloni surfaces on the very next load instead
      // of waiting out the 24h TTL. Drafts are simply re-fetched each load
      // (bounded by the concurrency cap above).
      if (cached && cached.status !== "draft") return { ...cached, order_id_link: orderId } as InvoiceMeta;
      const m = await meta.fetchMeta(invoiceId, orderId, metaDeadline);
      if (m && m.status !== "draft") {
        const { order_id_link, ...store } = m;
        await appStorage.cacheInvoiceMeta(invoiceId, store, meta.metaNs);
      }
      return m;
    }
  );
  const invoicesByOrderId = new Map<string, InvoiceMeta>();
  const allInvoiceMetas: InvoiceMeta[] = [];
  for (let i = 0; i < invoiceEntries.length; i++) {
    const m = invoiceMetas[i];
    if (m) {
      invoicesByOrderId.set(invoiceEntries[i][0], m);
      allInvoiceMetas.push(m);
    }
  }

  // Source-specific "held, not yet invoiced" copy.
  const pendingReason = ctx.source === "lodgify"
    ? "Reserva por confirmar / pagamento parcial — fatura ainda não emitida"
    : "Aguarda confirmação de pagamento — fatura não por emitir";

  // 6. Build rows
  const rows: ReconciliationRow[] = orders.map(orderBlock => {
    const orderId = orderBlock.id;
    const totalNum = orderBlock.total;
    const customerName = orderBlock.customer_name;

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
      const expectedRef = `Order #${orderBlock.order_number}`;
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
          number: inv.number,
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
    // couldn't be read this round (proxy slow/over capacity). The invoice exists
    // — invoice_id is only ever persisted after a successful create — so we MUST
    // NOT fall through to "Sem fatura". Render it as issued, flagged
    // meta_unavailable so the UI shows "detalhe indisponível".
    const knownInvoiceId = orderToInvoice.get(orderId);
    if (knownInvoiceId) {
      return {
        order: orderBlock,
        match: {
          type: manualMatch ? "approved" : "exact",
          confidence: 100,
          reason: "Fatura emitida — detalhe indisponível de momento",
        },
        invoice: {
          id: knownInvoiceId,
          reference: null, number: null, status: null, total: null, date: null,
          permalink: null, pdf_url: null, client_name: null,
          meta_unavailable: true,
        },
        candidates: [],
      };
    }

    // Pending order/booking with no invoice = intentionally held until payment
    // confirms. NOT an alarm and NOT a heuristic candidate — it's correctly
    // waiting. Give it its own state so the operator sees it's tracked.
    if (String(orderBlock.financial_status) !== "paid") {
      return {
        order: orderBlock,
        match: { type: "pending", confidence: 0, reason: pendingReason },
        invoice: null,
        candidates: [],
      };
    }

    // Heuristic: score against the invoice pool we already fetched
    const candidates = allInvoiceMetas
      .filter(im => im.order_id_link !== orderId)
      .map(im => {
        const { score, reasons } = scoreHeuristicMatch(
          { amount: totalNum, date: orderBlock.paid_at, customerName, reference: `${orderBlock.order_number}` },
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
  // ask the destination whether a document with our "Order #N" reference exists.
  // Catches (a) invoices created but whose DB mapping was lost (a create that
  // timed out after the destination had issued it) and (b) manual invoices that
  // followed the reference convention. Bounded (capped concurrency + deadline)
  // and cached per reference (id or "MISS", 1h TTL).
  const noneRows = rows.filter(r => r.match.type === "none");
  if (noneRows.length > 0) {
    const refOf = (r: ReconciliationRow) => `Order #${r.order.order_number}`;
    const refDeadline = Date.now() + 8_000;
    const cachedRefs = await appStorage.getCachedRefLookups(meta.refAccount, noneRows.map(refOf), meta.refNs);
    await mapWithConcurrency(noneRows, 4, async (row) => {
      if (Date.now() >= refDeadline) return;
      const ref = refOf(row);
      let invoiceId: string | null = null;
      const cached = cachedRefs.get(ref);
      if (cached === "MISS") return;
      if (cached) invoiceId = cached;
      else {
        invoiceId = await meta.findByReference(ref, refDeadline);
        await appStorage.cacheRefLookup(meta.refAccount, ref, invoiceId ?? "MISS", meta.refNs);
      }
      if (!invoiceId) return;
      const m = await meta.fetchMeta(invoiceId, row.order.id, refDeadline);
      if (!m) return;
      const { order_id_link, ...store } = m;
      if (m.status !== "draft") await appStorage.cacheInvoiceMeta(invoiceId, store, meta.metaNs);
      row.match = { type: "heuristic", confidence: 90, reason: "Encontrada por referência (não mapeada na BD)" };
      row.invoice = {
        id: m.id, reference: m.reference, number: m.number, status: m.status, total: m.total,
        date: m.date, permalink: m.permalink, pdf_url: m.pdf_url, client_name: m.client_name,
      };
      row.candidates = [];
    });
  }

  // Sort newest first
  rows.sort((a, b) => Date.parse(b.order.paid_at) - Date.parse(a.order.paid_at));

  return {
    from,
    to,
    source: ctx.source,
    destination: ctx.destination,
    total_orders: rows.length,
    summary: {
      exact: rows.filter(r => r.match.type === "exact").length,
      approved: rows.filter(r => r.match.type === "approved").length,
      heuristic: rows.filter(r => r.match.type === "heuristic").length,
      none: rows.filter(r => r.match.type === "none").length,
      not_needed: rows.filter(r => r.match.type === "not_needed").length,
      pending: rows.filter(r => r.match.type === "pending").length,
      unverified: rows.filter(r => r.invoice?.meta_unavailable).length,
    },
    rows,
  };
}

export async function approveReconciliationMatch(
  env: Env,
  scope: string,
  orderId: string,
  invoiceId: string,
  approvedBy: string | null
) {
  const appStorage = new AppStorage(env, scope);
  await appStorage.upsertReconciliationMatch(orderId, invoiceId, approvedBy);
  return { ok: true, order_id: orderId, invoice_id: invoiceId };
}

export async function revertReconciliationMatch(env: Env, scope: string, orderId: string) {
  const appStorage = new AppStorage(env, scope);
  await appStorage.deleteReconciliationMatch(orderId);
  return { ok: true, order_id: orderId };
}

export async function setReconciliationDecisionAction(
  env: Env,
  scope: string,
  orderId: string,
  decision: string | null,
  reason: string | null,
  decidedBy: string | null
) {
  const appStorage = new AppStorage(env, scope);
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
