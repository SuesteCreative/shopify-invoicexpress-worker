import type { Env } from "../env";
import type { IRequestConfig, SourceKind, DestinationKind } from "../storage";
import { AppStorage } from "../storage";
import type { AdapterCtx } from "../adapters/types";
import { getMoloniCfg, getAccessToken, moloniCall } from "../adapters/destinations/moloni-destination";
import { stripeFetch } from "../services/stripe";
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
  /** Normalized refund/cancellation state, source-agnostic. Each source fetcher
   * maps its native status (Shopify financial_status/cancelled_at, Lodgify
   * cancelled/declined, future Stripe amount_refunded, …) into this enum so the
   * reconciliation core — and the credit-note lookup below — stays generic.
   * `partial` = partly refunded, `full` = fully refunded, `cancelled` = order
   * cancelled (or a booking cancelled after being confirmed). Null/absent = a
   * normal live order. A DECLINED booking is tracked separately (see `declined`),
   * not as a cancellation. */
  refund_state?: "partial" | "full" | "cancelled" | null;
  /** ISO timestamp the order was cancelled (Shopify `cancelled_at`), if any. */
  cancelled_at?: string | null;
  /** Lodgify booking whose status is `Declined` — an enquiry the host declined,
   * never paid, never invoiced. Surfaced on conciliação as "fatura não
   * necessária" instead of being dropped (the merchant asked to see these), and
   * distinct from `cancelled` (which may hold an invoice needing a credit note). */
  declined?: boolean | null;
}

/** A credit note (nota de crédito) issued against an order's invoice. Populated
 * only for rows whose order carries a `refund_state`. The link back to the
 * original invoice lives at the provider (IX `owner_invoice_id`, Moloni
 * `associated_documents`), not in our DB, so these are read back live per run. */
export interface ReconCredit {
  id: string;
  /** Human doc number (IX `sequence_number`, Moloni finalized number). */
  number: string | null;
  reference: string | null;
  status: string | null;
  total: number | null;
  date: string | null;
  permalink: string | null;
  pdf_url: string | null;
}

export interface ReconInvoice {
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
}

export interface ReconciliationRow {
  order: ReconOrder;
  match: {
    type: "exact" | "approved" | "heuristic" | "not_needed" | "none" | "pending";
    confidence: number;
    reason?: string;
  };
  /** Primary invoice (first instalment for split bookings) — kept for existing
   * consumers (Excel export, single-invoice UI). `invoices` holds ALL of them. */
  invoice: ReconInvoice | null;
  /** All invoices mapped to this booking. >1 when a booking is invoiced in
   * instalments (e.g. 50% deposit + 50% balance). Absent/length≤1 otherwise. */
  invoices?: ReconInvoice[];
  /** Credit notes found for this order's invoice(s). Populated only when the
   * order is refunded/cancelled (`order.refund_state` set). Empty array on a
   * refunded order that has an invoice ⇒ the "nota de crédito não emitida" alarm. */
  credit_notes?: ReconCredit[];
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
  // Merge passes, de-duping by order id (first pass wins).
  const seen = new Set(paidOrders.map(o => String(o.id)));
  const orders = [...paidOrders];
  const merge = (extra: any[]) => {
    for (const o of extra) {
      const id = String(o.id);
      if (seen.has(id)) continue;
      seen.add(id); orders.push(o);
    }
  };
  // When the shop holds invoices until payment (only_invoice_when_paid), also
  // pull pending orders so the operator sees what is deliberately NOT yet
  // invoiced ("fatura não por emitir"). Pending orders rarely carry a
  // processed_at, so that set is windowed by created_at instead.
  if (config.only_invoice_when_paid === 1) {
    merge(await fetchShopifyOrdersPaginated(config, from, to, { financialStatus: "pending", dateField: "created_at" }));
  }
  // Refunded / partially-refunded orders are EXCLUDED by financial_status=paid,
  // so without these passes a refunded-but-invoiced order silently drops off the
  // view. They were paid, so they carry a processed_at (default date field). We
  // pull them so their credit note (nota de crédito) can be surfaced on the row.
  merge(await fetchShopifyOrdersPaginated(config, from, to, { financialStatus: "refunded" }));
  merge(await fetchShopifyOrdersPaginated(config, from, to, { financialStatus: "partially_refunded" }));

  const shopDomain = config.shopify_domain!;
  return orders.map((order) => {
    const orderId = String(order.id);
    const customerName = order.customer
      ? `${order.customer.first_name ?? ""} ${order.customer.last_name ?? ""}`.trim() || null
      : null;
    const fin = order.financial_status ?? null;
    const cancelledAt = order.cancelled_at ?? null;
    // Normalized, source-agnostic refund state (see ReconOrder.refund_state).
    const refundState: ReconOrder["refund_state"] =
      fin === "refunded" || fin === "voided" ? "full"
      : fin === "partially_refunded" ? "partial"
      : cancelledAt ? "cancelled"
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
      financial_status: fin,
      refund_state: refundState,
      cancelled_at: cancelledAt,
    };
  });
}

// Live Lodgify fetch — used ONLY to bootstrap conciliação before the poll has
// populated the local `lodgify_bookings` mirror. Pulls the COMPLETE list from
// the v1 `/v1/reservation` endpoint (offset/limit paging) — the same source the
// poll uses — because the v2 list silently omits some bookings. 429 retry/backoff
// plus a short KV cache so repeated pre-sync loads don't re-hit the rate-limited
// API. Steady state reads D1, so this rarely runs. `_fromYmd` is unused (v1 has
// no reliable updated filter); the window filter is applied by the caller.
async function liveFetchLodgifyBookings(env: Env, ctx: ReconContext, _fromYmd: string): Promise<any[]> {
  const apiKey = ctx.sourceConfig?.api_key;
  if (!apiKey) return [];
  const cacheKey = `lodgifylistv1:${ctx.userId ?? "x"}`;
  try {
    const cached = await env.INVOICE_KV.get(cacheKey);
    if (cached) return JSON.parse(cached) as any[];
  } catch { /* treat as miss */ }

  const items: any[] = [];
  const limit = 50;
  const headers = { "X-ApiKey": apiKey, "Accept": "application/json" };
  for (let page = 0; page < 40; page++) {
    const url = `https://api.lodgify.com/v1/reservation?offset=${page * limit}&limit=${limit}&trash=False`;
    let pageItems: any[] | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(url, { headers });
      if (res.ok) {
        const data: any = await res.json().catch(() => null);
        pageItems = Array.isArray(data?.items) ? data.items
          : Array.isArray(data) ? data
          : [];
        break;
      }
      if (res.status === 429) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 6000) : 700 * (attempt + 1));
        continue;
      }
      console.error(`[Recon] Lodgify v1 live page ${page} → ${res.status} ${res.statusText}`);
      break;
    }
    if (pageItems == null) break;
    // Alias v1 payment/currency fields to the v2 shape fetchLodgifyReconOrders
    // reads (amount_due drives the paid/pending split).
    for (const it of pageItems) {
      const cur = (it as any)?.currency;
      items.push({
        ...it,
        amount_due: (it as any)?.amount_to_pay ?? (it as any)?.amount_due ?? null,
        amount_paid: (it as any)?.total_paid ?? (it as any)?.amount_paid ?? null,
        currency_code: typeof cur === "string" ? cur : (cur?.code ?? "EUR"),
      });
    }
    if (pageItems.length < limit) break;
    await sleep(250);
  }
  if (items.length > 0) {
    try { await env.INVOICE_KV.put(cacheKey, JSON.stringify(items), { expirationTtl: 600 }); } catch { /* best-effort */ }
  }
  return items;
}

// Lodgify bookings for the window, read from the local mirror (see above). A
// booking is included if it was MADE (created_at) in [from, to] OR its stay
// (arrival) falls in [from, to]. Created alone would hide bookings made earlier
// that arrive now; arrival alone hides bookings just made for a future stay —
// the common PMS case, and what the operator expects to see right after a
// booking comes in. Payment ("paid" iff amount_due≈0) is orthogonal — unpaid
// bookings still show (as "pending"). Declined/cancelled are omitted.
async function fetchLodgifyReconOrders(env: Env, ctx: ReconContext, from: string, to: string): Promise<ReconOrder[]> {
  const fromYmd = dateOnly(from);
  const toYmd = dateOnly(to);
  const userId = ctx.userId;

  // Primary source: the local `lodgify_bookings` mirror the 30-min poll keeps in
  // sync. Reading D1 means NO Lodgify call on page load — immune to the 429 rate
  // limit that killed this view. Window filter matches the row-loop below
  // (booking made OR arriving in [from,to]).
  let items: any[] = [];
  let haveMirror = false;
  if (userId) {
    try {
      const res = await env.DB.prepare(
        `SELECT raw_json FROM lodgify_bookings
         WHERE user_id = ?
           AND ( (created_at IS NOT NULL AND substr(created_at,1,10) BETWEEN ? AND ?)
                 OR (arrival IS NOT NULL AND arrival BETWEEN ? AND ?) )`
      ).bind(userId, fromYmd, toYmd, fromYmd, toYmd).all();
      items = ((res.results ?? []) as any[])
        .map((r) => { try { return JSON.parse(r.raw_json); } catch { return null; } })
        .filter((b): b is any => b !== null);
      // Tell "synced but window empty" apart from "never synced". Only the
      // latter falls back to a live fetch (bootstrap before the first poll).
      haveMirror = items.length > 0
        || !!(await env.DB.prepare(`SELECT 1 FROM lodgify_bookings WHERE user_id = ? LIMIT 1`).bind(userId).first());
    } catch (e) {
      console.error("[Recon] lodgify_bookings read failed:", e);
    }
  }

  // Bootstrap fallback: mirror not yet populated for this user → fetch live.
  if (!haveMirror) {
    items = await liveFetchLodgifyBookings(env, ctx, fromYmd);
  }

  const rows: ReconOrder[] = [];
  for (const b of items) {
    const status = String(b.status ?? b.state ?? "").toLowerCase();
    // A cancelled booking that already holds an invoice needs its credit note
    // surfaced, so tag it `cancelled` (getReconciliation drops cancelled bookings
    // that were never invoiced). A DECLINED booking is different — an enquiry the
    // host declined, never paid, never invoiced — so we DON'T drop it: mark it
    // `declined` and the row builder renders it "fatura não necessária" (the
    // merchant asked to see these on conciliação instead of them vanishing).
    const isDeclined = status === "declined";
    const isCancelled = status === "cancelled" || status === "canceled";
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
      refund_state: isCancelled ? "cancelled" : null,
      declined: isDeclined || undefined,
    });
  }
  return rows;
}

// Live Stripe fetch — the left side for Stripe-source connections. Walks
// `payment_intents.list` over [from,to] via the connection's restricted_key
// (Stripe has no server-side status filter on this endpoint, so we paginate and
// keep only status=succeeded — a captured payment). `expand[]=data.latest_charge`
// gives us the payer name/email and the refund state in one call, no per-PI
// round-trips. Connect direct-charge accounts require the Stripe-Account header,
// which stripeFetch adds from stripe_account_id.
async function fetchStripeReconOrders(ctx: ReconContext, from: string, to: string): Promise<ReconOrder[]> {
  const restrictedKey = ctx.sourceConfig?.restricted_key as string | undefined;
  if (!restrictedKey) return [];
  const stripeAccount = (ctx.sourceConfig?.stripe_account_id as string | undefined) ?? null;
  const fromUnix = Math.floor(new Date(from).getTime() / 1000);
  const toUnix = Math.floor(new Date(to).getTime() / 1000);

  const out: ReconOrder[] = [];
  let startingAfter: string | null = null;
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams();
    params.set("created[gte]", String(fromUnix));
    params.set("created[lte]", String(toUnix));
    params.set("limit", "100");
    params.append("expand[]", "data.latest_charge");
    if (startingAfter) params.set("starting_after", startingAfter);

    const res = await stripeFetch("payment_intents", restrictedKey, { stripeAccount, query: params });
    if (!res.ok) {
      console.error(`[Recon] Stripe paymentIntents.list ${res.status}: ${(await res.text()).slice(0, 200)}`);
      break;
    }
    const body: any = await res.json();
    const list: any[] = Array.isArray(body?.data) ? body.data : [];
    for (const pi of list) {
      // Only captured payments are billable events. Skip incomplete
      // (requires_payment_method / requires_action) and canceled intents.
      if (pi.status !== "succeeded") continue;
      const ch = pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : null;
      const amountRefunded = Number(ch?.amount_refunded ?? 0);
      const refundState: ReconOrder["refund_state"] =
        ch?.refunded ? "full"
        : amountRefunded > 0 ? "partial"
        : null;
      const name = ch?.billing_details?.name ?? pi.shipping?.name ?? null;
      const email = ch?.billing_details?.email ?? pi.receipt_email ?? null;
      const dashPath = stripeAccount ? `${stripeAccount}/payments` : "payments";
      out.push({
        id: String(pi.id),
        order_number: numericFromId(pi.id),
        name: String(pi.id),
        total: Number(pi.amount ?? 0) / 100,
        paid_at: new Date(Number(pi.created ?? 0) * 1000).toISOString(),
        customer_name: name ? String(name) : null,
        email: email ? String(email) : null,
        permalink: `https://dashboard.stripe.com/${dashPath}/${pi.id}`,
        financial_status: "paid",
        refund_state: refundState,
      });
    }
    if (!body.has_more || list.length === 0) break;
    startingAfter = list[list.length - 1]?.id ?? null;
    if (!startingAfter) break;
  }
  return out;
}

// Stripe→Moloni backfill link. Invoices raised by a PREVIOUS integrator are NOT
// in our `processed_orders`, so they'd show as "Sem fatura" even though the
// fatura exists in Moloni. The previous integrator stamps the PaymentIntent id
// on the Moloni doc as `your_reference = "#stripe_" + <pi_id>` (verified live on
// MY VAN TRAVEL: doc your_reference `#stripe_pi_3Tpnfn…` ↔ PI `pi_3Tpnfn…`). We
// page Moloni's docs once, build a { pi_id → document_id } index, and cache it
// in KV so subsequent page loads don't re-page Moloni. Rioko's OWN invoices
// already live in processed_orders, so this only fills the historical gap.
async function buildStripeMoloniRefIndex(ctx: ReconContext, fromYmd: string): Promise<Record<string, string>> {
  const ctxLike = { apiKey: "", config: ctx.config, destinationConfig: ctx.destinationConfig } as AdapterCtx;
  const cfg = await getMoloniCfg(ctxLike);
  const token = await getAccessToken(cfg);
  const index: Record<string, string> = {};
  // Old docs land under whichever series/type the previous integrator used
  // (seen filed under invoiceReceipts even when the set is named "FT…"), so we
  // sweep both endpoints. Most-recent-first; stop once a full page is entirely
  // older than the window, or the offset cap is hit.
  for (const path of ["/invoiceReceipts/getAll/", "/invoices/getAll/"]) {
    for (let offset = 0; offset < 2000; offset += 50) {
      let docs: any[];
      try {
        docs = await moloniCall<any[]>(cfg, token, path, { qty: 50, offset, order_by: "date_desc" }, "lookup");
      } catch {
        break; // endpoint unavailable / transient — take what we have
      }
      const arr = Array.isArray(docs) ? docs : [];
      if (arr.length === 0) break;
      let allOlder = true;
      for (const d of arr) {
        const ref = String(d?.your_reference ?? "");
        // "#stripe_" + <pi id> — tolerate the "#" being absent and match on the
        // embedded pi_ token so a format tweak on the source side still links.
        const m = ref.match(/(pi_[A-Za-z0-9]+)/);
        if (m && d?.document_id != null) index[m[1]] = String(d.document_id);
        const docYmd = dateOnly(d?.date ?? "");
        if (!docYmd || docYmd >= fromYmd) allOlder = false;
      }
      if (arr.length < 50 || allOlder) break;
      await sleep(200); // be gentle on Moloni's rate limit
    }
  }
  return index;
}

async function getStripeMoloniRefIndex(env: Env, ctx: ReconContext, fromYmd: string): Promise<Map<string, string>> {
  const cacheKey = `stripemol_refidx:${ctx.userId ?? "x"}:${fromYmd}`;
  try {
    const cached = await env.INVOICE_KV.get(cacheKey);
    if (cached) return new Map(Object.entries(JSON.parse(cached) as Record<string, string>));
  } catch { /* treat as miss */ }
  let index: Record<string, string> = {};
  try {
    index = await buildStripeMoloniRefIndex(ctx, fromYmd);
  } catch (e) {
    console.error("[Recon] Stripe→Moloni ref index build failed:", e);
    return new Map();
  }
  try {
    await env.INVOICE_KV.put(cacheKey, JSON.stringify(index), { expirationTtl: 1800 });
  } catch { /* best-effort */ }
  return new Map(Object.entries(index));
}

async function getSourceOrders(env: Env, ctx: ReconContext, from: string, to: string): Promise<ReconOrder[]> {
  switch (ctx.source) {
    case "lodgify": return fetchLodgifyReconOrders(env, ctx, from, to);
    case "shopify": return fetchShopifyReconOrders(ctx, from, to);
    case "stripe": return fetchStripeReconOrders(ctx, from, to);
    default:
      // EuPago reconciliation not implemented yet — no left-side list.
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
  /** Credit notes issued against `invoiceId` at the destination, linked via the
   * provider's own back-reference (IX `owner_invoice_id` / Moloni
   * `associated_documents`). `orderNumber` lets destinations that can't read the
   * association directly fall back to the "OrderCancel #N" reference convention.
   * Returns [] when none (or when the destination has no credit-note read path). */
  fetchCredits(invoiceId: string, orderNumber: number, deadline?: number): Promise<ReconCredit[]>;
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

// Credit notes issued against an IX invoice. IX exposes them directly via the
// document's "related" collection (owner_invoice_id links them), so one call
// yields every credit note with its permalink already populated — the clean
// primitive. Same fragile-proxy discipline as fetchIxInvoiceMeta (AbortController
// + deadline); a hung read returns [] rather than blocking the whole run.
async function fetchIxCredits(
  config: IRequestConfig,
  invoiceId: string,
  deadline?: number,
): Promise<ReconCredit[]> {
  const ixHeaders = {
    "x-account-name": config.ix_account_name!,
    "x-api-key": config.ix_api_key!,
    "x-env": config.ix_environment === "production" ? "prod" : "dev",
    "Accept": "application/json",
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (deadline && Date.now() >= deadline) return [];
    const budget = deadline ? Math.max(500, Math.min(5000, deadline - Date.now())) : 5000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      const res = await fetch(`${IX_PROXY_BASE}/v2/documents/${Number(invoiceId)}/related`, {
        headers: ixHeaders,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        if (res.status === 404) return []; // invoice gone / no related docs
        if (attempt < 2 && (!deadline || Date.now() < deadline)) { await sleep(300 * (attempt + 1)); continue; }
        return [];
      }
      const j: any = await res.json().catch(() => null);
      const docs: any[] = Array.isArray(j?.data?.documents) ? j.data.documents : [];
      return docs
        .filter((d) => d?.type === "CreditNote")
        .map((d): ReconCredit => ({
          id: String(d.id),
          number: d.sequence_number ?? null,
          reference: d.reference ?? null,
          status: d.status ?? null,
          total: Number(d.total ?? d.sum ?? 0),
          date: d.date ?? null,
          permalink: d.permalink ?? null,
          pdf_url: d.permalink ?? null,
        }));
    } catch {
      clearTimeout(timer);
      if (attempt < 2 && (!deadline || Date.now() < deadline)) { await sleep(200); continue; }
      return [];
    }
  }
  return [];
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
  // Tag-routing can emit EITHER an invoice or an invoice_receipt (and any
  // series), so a stored document_id may live under either endpoint. Try the
  // connection default first, then the other.
  const getOnePaths = docType === "invoice_receipt"
    ? ["/invoiceReceipts/getOne/", "/invoices/getOne/"]
    : ["/invoices/getOne/", "/invoiceReceipts/getOne/"];
  const getAllPaths = docType === "invoice_receipt"
    ? ["/invoiceReceipts/getAll/", "/invoices/getAll/"]
    : ["/invoices/getAll/", "/invoiceReceipts/getAll/"];
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

  // Moloni returns `[]` (empty array) from getOne when the id isn't of that
  // document type; a real hit is an object carrying document_id.
  const isRealDoc = (d: any): boolean =>
    !!d && typeof d === "object" && !Array.isArray(d) && d.document_id != null;

  return {
    metaNs: "molmeta",
    refNs: "molref",
    refAccount: account,
    async fetchMeta(invoiceId, orderId, deadline) {
      if (deadline && Date.now() >= deadline) return null;
      try {
        const { cfg, token } = await getCreds();
        // Query both doc-type endpoints; the id may be an invoice OR an
        // invoice_receipt (tag-routing). First real hit wins. If NEITHER has it
        // (deleted/replaced), return null so ref-recovery / "detalhe
        // indisponível" handles it — never a phantom "draft #id / 0€".
        let d: any = null;
        for (const path of getOnePaths) {
          if (deadline && Date.now() >= deadline) break;
          const r: any = await moloniCall(cfg, token, path, { document_id: Number(invoiceId) }, "lookup");
          if (isRealDoc(r)) { d = r; break; }
        }
        if (!d) return null;
        // Moloni names gross_value / net_value inconsistently (see moloni-api-quirks);
        // pick the larger so the total is the gross regardless of the labelling.
        const total = Math.max(Number(d.net_value ?? 0), Number(d.gross_value ?? 0)) || Number(d.total ?? 0);
        const clientName = d.entity?.name ?? d.entity_name ?? d.customer?.name ?? null;
        // status 0 = draft (rascunho). ANY non-zero status is a finalized/closed
        // document (seen 1 and 2 live), so treat "not draft" as final rather
        // than testing status===1 — otherwise a finalized doc renders as draft.
        const isFinal = Number(d.status) !== 0;
        const docId = String(d.document_id ?? invoiceId);
        // Moloni assigns number=-1 to drafts; a real sequential number only
        // exists once finalized. Show the finalized number (prefixed with the
        // document set, e.g. "VLFR 137") when available, else the internal doc
        // id "#<id>" so the draft is still identifiable in Moloni.
        const num = Number(d.number);
        const number = isFinal && Number.isFinite(num) && num > 0
          ? `${d.document_set_name ? `${d.document_set_name} ` : ""}${num}`
          : `#${docId}`;
        // Moloni exposes a shareable PDF link only for FINALIZED documents.
        // Best-effort: fetch it so a finalized invoice is clickable. Failure
        // (draft, valid:0, transient) leaves the link null.
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
        // Search across BOTH doc types and ALL series (no document_set_id) —
        // tag-routing can file the doc under a different series (e.g. VLFR),
        // which a set-scoped lookup would miss. our_reference "Order #N" is
        // unique per booking.
        for (const path of getAllPaths) {
          if (deadline && Date.now() >= deadline) break;
          const found = await moloniCall<Array<{ document_id?: number }>>(
            cfg, token, path, { our_reference: reference }, "lookup",
          );
          const first = Array.isArray(found) ? found[0] : null;
          if (first?.document_id) return String(first.document_id);
        }
        return null;
      } catch {
        return null;
      }
    },
    async fetchCredits(invoiceId, orderNumber, deadline) {
      if (deadline && Date.now() >= deadline) return [];
      try {
        const { cfg, token } = await getCreds();
        // Two lookups, deduped by document_id:
        //  (a) associated_id — the machine link the credit note carries back to
        //      its invoice (moloni-destination writes associated_documents:[{associated_id}]).
        //  (b) our_reference "OrderCancel #<n>" — the deterministic cancel ref, in
        //      case (a) isn't returned inline by getAll (validate live).
        const byId = new Map<string, any>();
        const collect = (arr: any) => {
          for (const d of Array.isArray(arr) ? arr : []) {
            const id = d?.document_id;
            if (id != null) byId.set(String(id), d);
          }
        };
        // (a) associated_id filter — Moloni ignores unknown filters (returns all),
        // so we re-filter client-side on associated_documents to stay correct.
        const assoc = await moloniCall<any[]>(
          cfg, token, "/creditNotes/getAll/", { associated_id: Number(invoiceId) }, "lookup",
        ).catch(() => []);
        collect((Array.isArray(assoc) ? assoc : []).filter((d) =>
          (Array.isArray(d?.associated_documents) ? d.associated_documents : [])
            .some((a: any) => Number(a?.associated_id) === Number(invoiceId)),
        ));
        // (b) deterministic cancel reference — catches the admin manual-cancel
        // convention "OrderCancel #<orderNumber>" (see admin.ts). NOTE: automatic
        // refunds do NOT use this — their credit note is "OrderRefund #<refundId>"
        // (refundId, unknown here), so path (c) is what links those.
        if (!deadline || Date.now() < deadline) {
          const byRef = await moloniCall<any[]>(
            cfg, token, "/creditNotes/getAll/", { our_reference: `OrderCancel #${orderNumber}` }, "lookup",
          ).catch(() => []);
          collect((Array.isArray(byRef) ? byRef : []).filter((d) =>
            String(d?.our_reference ?? "") === `OrderCancel #${orderNumber}`,
          ));
        }
        // (c) Invoice-side link — the reliable path for AUTOMATIC refund credit
        // notes. The parent invoice's `associated_table` lists the credit notes
        // attached to it (Moloni's reverse link; mirrors the clean IX
        // /documents/{id}/related path). Independent of the reference convention
        // and of whether getAll returns associated_documents inline. Resolve each
        // linked id via creditNotes/getOne (which returns [] for non-credit-note
        // ids, so receipts/other associations are naturally skipped).
        if (!deadline || Date.now() < deadline) {
          let inv: any = null;
          for (const path of getOnePaths) {
            if (deadline && Date.now() >= deadline) break;
            const r: any = await moloniCall(cfg, token, path, { document_id: Number(invoiceId) }, "lookup").catch(() => null);
            if (isRealDoc(r)) { inv = r; break; }
          }
          const links = Array.isArray(inv?.associated_table) ? inv.associated_table : [];
          for (const a of links) {
            if (deadline && Date.now() >= deadline) break;
            const cnId = Number(a?.associated_id ?? a?.document_id ?? a?.related_id ?? a?.associated_document_id ?? 0);
            if (!cnId || byId.has(String(cnId))) continue;
            const cn: any = await moloniCall(cfg, token, "/creditNotes/getOne/", { document_id: cnId }, "lookup").catch(() => null);
            if (isRealDoc(cn)) byId.set(String(cn.document_id), cn);
          }
        }
        const out: ReconCredit[] = [];
        for (const d of byId.values()) {
          const total = Math.max(Number(d.net_value ?? 0), Number(d.gross_value ?? 0)) || Number(d.total ?? 0);
          const isFinal = Number(d.status) !== 0;
          const docId = String(d.document_id);
          const num = Number(d.number);
          const number = isFinal && Number.isFinite(num) && num > 0
            ? `${d.document_set_name ? `${d.document_set_name} ` : ""}${num}`
            : `#${docId}`;
          let permalink: string | null = null;
          if (isFinal && (!deadline || Date.now() < deadline)) {
            try {
              const pdf: any = await moloniCall(cfg, token, "/documents/getPDFLink/", { document_id: Number(docId) }, "lookup");
              permalink = (pdf?.url ?? pdf?.link ?? null) as string | null;
            } catch { /* no public link — leave null */ }
          }
          out.push({
            id: docId,
            number,
            reference: d.our_reference ?? null,
            status: isFinal ? "final" : "draft",
            total,
            date: dateOnly(d.date ?? "") || String(d.date ?? ""),
            permalink,
            pdf_url: permalink,
          });
        }
        return out;
      } catch {
        return [];
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
    fetchCredits: (invoiceId, _orderNumber, deadline) => fetchIxCredits(config, invoiceId, deadline),
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
        fetchCredits: async () => [],
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
  const orders = await getSourceOrders(env, ctx, from, to);
  const orderIds = orders.map(o => o.id);

  // 2. Map order → invoice_id(s). processed_orders holds the single (standard)
  //    invoice per booking; lodgify_partial_invoices holds instalment invoices
  //    (progressive 50/50 billing), so a booking can map to several.
  const orderToInvoice = await appStorage.getProcessedInvoicesByOrderIds(orderIds, ctx.source);
  const partialsByOrder = ctx.source === "lodgify" && ctx.userId
    ? await appStorage.getPartialInvoicesByBookingIds(ctx.userId, orderIds)
    : new Map<string, string[]>();

  // 2b. Stripe→Moloni: link invoices raised by a PREVIOUS integrator (absent
  //     from processed_orders) via the PaymentIntent id stamped on the Moloni
  //     doc's your_reference. Only fills gaps — never overrides our own mapping.
  if (ctx.source === "stripe" && ctx.destination === "moloni" && orderIds.length > 0) {
    const unmapped = orderIds.filter((oid) => !orderToInvoice.has(oid));
    if (unmapped.length > 0) {
      const refIndex = await getStripeMoloniRefIndex(env, ctx, dateOnly(from));
      for (const oid of unmapped) {
        const docId = refIndex.get(oid);
        if (docId) orderToInvoice.set(oid, docId);
      }
    }
  }

  // 3. Overrides (manual matches + decisions), scoped to this integration.
  const { matches: manualMatches, decisions } = await appStorage.getReconciliationOverrides(orderIds);

  // 4. Manual override invoice IDs supplement automatic mapping.
  for (const [orderId, m] of manualMatches.entries()) {
    if (!orderToInvoice.has(orderId)) orderToInvoice.set(orderId, m.invoice_id);
  }

  // Combined order → [invoiceId, …] (dedup; standard first, then instalments).
  const orderInvoiceIds = new Map<string, string[]>();
  const addInvoiceId = (oid: string, id: string) => {
    if (!id) return;
    const arr = orderInvoiceIds.get(oid) ?? [];
    if (!arr.includes(id)) { arr.push(id); orderInvoiceIds.set(oid, arr); }
  };
  for (const [oid, id] of orderToInvoice.entries()) addInvoiceId(oid, id);
  for (const [oid, ids] of partialsByOrder.entries()) for (const id of ids) addInvoiceId(oid, id);

  // 5. Resolve metadata for every invoice id: KV cache FIRST (so we stop
  //    hammering the destination on every load), else bounded-concurrency fetch.
  const metaDeadline = Date.now() + 12_000;
  const invoiceEntries: Array<[string, string]> = [];
  for (const [oid, ids] of orderInvoiceIds.entries()) for (const id of ids) invoiceEntries.push([oid, id]);
  const cachedMetas = await appStorage.getCachedInvoiceMetas(invoiceEntries.map(([, invoiceId]) => invoiceId), meta.metaNs);
  const invoiceMetas = await mapWithConcurrency(
    invoiceEntries, 6,
    async ([orderId, invoiceId]) => {
      const cached = cachedMetas.get(String(invoiceId));
      // Never serve OR write a cached DRAFT: its status/number/PDF link all
      // change the moment it's finalized. Caching only immutable finalized docs
      // means a manual finalize in Moloni surfaces on the very next load instead
      // of waiting out the 24h TTL. Drafts are simply re-fetched each load.
      if (cached && cached.status !== "draft") return { ...cached, order_id_link: orderId } as InvoiceMeta;
      const m = await meta.fetchMeta(invoiceId, orderId, metaDeadline);
      if (m && m.status !== "draft") {
        const { order_id_link, ...store } = m;
        await appStorage.cacheInvoiceMeta(invoiceId, store, meta.metaNs);
      }
      return m;
    }
  );
  const invoicesByOrderId = new Map<string, InvoiceMeta[]>();
  const allInvoiceMetas: InvoiceMeta[] = [];
  for (let i = 0; i < invoiceEntries.length; i++) {
    const m = invoiceMetas[i];
    if (!m) continue;
    const oid = invoiceEntries[i][0];
    const arr = invoicesByOrderId.get(oid) ?? [];
    arr.push(m);
    invoicesByOrderId.set(oid, arr);
    allInvoiceMetas.push(m);
  }
  const toRowInvoice = (m: InvoiceMeta): ReconInvoice => ({
    id: m.id, reference: m.reference, number: m.number, status: m.status,
    total: m.total, date: m.date, permalink: m.permalink, pdf_url: m.pdf_url,
    client_name: m.client_name,
  });

  // Source-specific "held, not yet invoiced" copy.
  const pendingReason = ctx.source === "lodgify"
    ? "Reserva por confirmar / pagamento parcial — fatura ainda não emitida"
    : "Aguarda confirmação de pagamento — fatura ainda não emitida";

  // 6. Build rows
  const rows: ReconciliationRow[] = orders.map((orderBlock): ReconciliationRow => {
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

    const invs = invoicesByOrderId.get(orderId) ?? [];
    const inv = invs[0];
    const manualMatch = manualMatches.get(orderId);

    if (inv) {
      const expectedRef = `Order #${orderBlock.order_number}`;
      // Exact if any mapped invoice carries the booking reference or an
      // "Order #N-<seq>" instalment reference.
      const isExact = invs.some(x => x.reference === expectedRef || (x.reference ?? "").startsWith(`${expectedRef}-`));
      const type: ReconciliationRow["match"]["type"] = manualMatch
        ? "approved"
        : isExact ? "exact" : "heuristic";
      return {
        order: orderBlock,
        match: { type, confidence: type === "heuristic" ? 80 : 100 },
        invoice: toRowInvoice(inv),
        invoices: invs.map(toRowInvoice),
        candidates: [],
      };
    }

    // We HOLD an invoice_id for this order (DB or manual match) but its metadata
    // couldn't be read this round (proxy slow/over capacity). The invoice exists
    // — invoice_id is only ever persisted after a successful create — so we MUST
    // NOT fall through to "Sem fatura". Render it as issued, flagged
    // meta_unavailable so the UI shows "detalhe indisponível".
    const knownInvoiceId = orderInvoiceIds.get(orderId)?.[0];
    if (knownInvoiceId) {
      const unavailable: ReconInvoice = {
        id: knownInvoiceId,
        reference: null, number: null, status: null, total: null, date: null,
        permalink: null, pdf_url: null, client_name: null,
        meta_unavailable: true,
      };
      return {
        order: orderBlock,
        match: {
          type: manualMatch ? "approved" : "exact",
          confidence: 100,
          reason: "Fatura emitida — detalhe indisponível de momento",
        },
        invoice: unavailable,
        invoices: [unavailable],
        candidates: [],
      };
    }

    // Declined booking (enquiry the host declined) with no invoice — nothing to
    // bill. Surface it as "não necessária" so the operator sees it was handled,
    // not as a missing-invoice alarm or a payment still pending.
    if (orderBlock.declined) {
      return {
        order: orderBlock,
        match: { type: "not_needed", confidence: 0, reason: "Reserva recusada — fatura não necessária" },
        invoice: null,
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
  }).filter(r =>
    // Drop cancelled orders/bookings that were never invoiced — nothing to
    // reconcile and no credit note to show (keeps declined-booking noise out,
    // matching the prior Lodgify behavior). A refund WITHOUT an invoice is a real
    // anomaly, so those (refund_state "full"/"partial") are kept visible.
    !(r.order.refund_state === "cancelled" && !r.invoice)
  );

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
      const recovered: ReconInvoice = {
        id: m.id, reference: m.reference, number: m.number, status: m.status, total: m.total,
        date: m.date, permalink: m.permalink, pdf_url: m.pdf_url, client_name: m.client_name,
      };
      row.invoice = recovered;
      row.invoices = [recovered];
      row.candidates = [];
    });
  }

  // 6c. Credit notes (notas de crédito). ONLY for rows whose order carries a
  // refund_state and holds an invoice id — gated so we don't add a destination
  // read per invoice on every load (the IX proxy is fragile, see the concurrency
  // comment above). Each invoice id is fetched once (deduped), bounded by
  // concurrency + deadline, and cached in KV (immutable finalized docs). Empty
  // results are NOT cached, so a "refund just happened, NC still pending" row
  // keeps re-checking until the credit note appears.
  const creditRows = rows.filter(r => !!r.order.refund_state && (!!r.invoice?.id || !!(r.invoices?.length)));
  if (creditRows.length > 0) {
    const creditDeadline = Date.now() + 8_000;
    const cnNs = `${meta.metaNs}_cn`;
    const invoiceIdsOf = (r: ReconciliationRow): string[] => {
      const ids = new Set<string>();
      if (r.invoice?.id) ids.add(r.invoice.id);
      for (const iv of r.invoices ?? []) if (iv.id) ids.add(iv.id);
      return [...ids];
    };
    const orderNumberByInvoice = new Map<string, number>();
    for (const r of creditRows) for (const id of invoiceIdsOf(r)) {
      if (!orderNumberByInvoice.has(id)) orderNumberByInvoice.set(id, r.order.order_number);
    }
    const uniqInvoiceIds = [...orderNumberByInvoice.keys()];
    const cachedCredits = await appStorage.getCachedInvoiceMetas(uniqInvoiceIds, cnNs);
    const creditsByInvoice = new Map<string, ReconCredit[]>();
    await mapWithConcurrency(uniqInvoiceIds, 4, async (invoiceId) => {
      const cached = cachedCredits.get(invoiceId) as ReconCredit[] | undefined;
      if (cached) { creditsByInvoice.set(invoiceId, cached); return; }
      if (Date.now() >= creditDeadline) { creditsByInvoice.set(invoiceId, []); return; }
      const credits = await meta.fetchCredits(invoiceId, orderNumberByInvoice.get(invoiceId) ?? 0, creditDeadline);
      if (credits.length > 0) await appStorage.cacheInvoiceMeta(invoiceId, credits, cnNs);
      creditsByInvoice.set(invoiceId, credits);
    });
    for (const r of creditRows) {
      const acc: ReconCredit[] = [];
      for (const id of invoiceIdsOf(r)) {
        for (const c of creditsByInvoice.get(id) ?? []) {
          if (!acc.some(x => x.id === c.id)) acc.push(c);
        }
      }
      r.credit_notes = acc;
    }
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
      // Refunded/cancelled orders in the window, and — the alarm — those with an
      // invoice but NO credit note found at the destination.
      refunded: rows.filter(r => !!r.order.refund_state).length,
      credit_missing: rows.filter(r => !!r.order.refund_state && !!r.invoice && (r.credit_notes?.length ?? 0) === 0).length,
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
