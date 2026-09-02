import type { Env } from "../env";
import { AppStorage } from "../storage";
import { processOrders } from "./admin";
import { processStripeBackfill } from "./admin-stripe";
import { reportIncident, INVOICE_FAILURE_KINDS } from "../services/incidents";
import { checkSubscriptionGate } from "../services/subscription-gate";
import { sendEmail } from "../services/email";

// ─────────────────────────────────────────────────────────────────────────────
// Self-healing invoice reconciliation sweep (Shopify→InvoiceXpress).
//
// WHY: the legacy Shopify→IX path normalizes each order through an external SPOF
// (endpoint-shopify.*.hstgr.cloud). When that box hiccups, the queue burns its
// retries and ACKs the message — the order is silently dropped and never
// invoiced until someone re-emits by hand. This sweep is the automatic backstop:
// once a day it re-derives the truth from the source (paid Shopify orders) vs
// what we invoiced, and re-emits any gap.
//
// SAFETY (this is invoicing — the whole point is it can't misfire):
//   • No duplicates. It drives the SAME reemit path as the admin tools
//     (processOrders → adminCreateOrder), which checks BOTH our D1 dedup AND the
//     destination by reference ("Order #N") before creating. A phantom (in IX
//     but not our DB) is synced, not re-created.
//   • No wrong totals. adminCreateOrder builds through the shared IxBuilder whose
//     1¢ reconcile guard throws on a mismatch → the order is reported as an error
//     for human review, NEVER force-invoiced with a wrong amount.
//   • Paid-only. processOrders filters financial_status=paid, so held/unpaid
//     orders (only_invoice_when_paid) are untouched.
//   • Paused shops skipped. No surprise invoicing on an intentionally-off shop.
//   • Finalize parity. adminCreateOrder only CREATES (draft). For auto_finalize=1
//     shops we run a finalize pass too, so the document ends up exactly as the
//     live path would have produced it. auto_finalize=0 shops keep drafts.
//
// It never touches the live queue path. Fully additive, flag-gated, reversible.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReconSweepOptions {
  /** When true, report what WOULD happen and write nothing (uses the admin dry-run path). */
  dryRun?: boolean;
  /** Restrict to these shopify_domains (staged rollout). Overrides RECON_SWEEP_SHOPS. */
  shops?: string[];
  /** Lookback window in days. Defaults to RECON_SWEEP_DAYS or 7. */
  days?: number;
}

interface ShopSweepRow {
  shop: string;
  /** Human-facing merchant name (admin_label/company_name/name), else the shop domain. */
  displayName: string;
  created: number;
  finalized: number;
  skipped: number;
  errors: number;
  wouldCreate: number;
  /** Left for the next run by the per-shop cap or the budget. 0 = fully drained. */
  deferred: number;
  /** 1 when the shop was skipped for having no active subscription. */
  skippedNoSubscription?: number;
  errorSamples: Array<{ order_number: number; order_id?: string; message: string }>;
}

export interface ReconSweepResult {
  ranAt: string;
  dryRun: boolean;
  window: { from: string; to: string };
  shopsScanned: number;
  totals: { created: number; finalized: number; skipped: number; errors: number; wouldCreate: number; deferred: number; skippedNoSubscription: number };
  perShop: ShopSweepRow[];
  /** Shops the wall-clock budget did not reach this run. Empty = full coverage. */
  skippedForBudget?: string[];
}

export async function runReconciliationSweep(env: Env, options: ReconSweepOptions = {}): Promise<ReconSweepResult> {
  const dryRun = !!options.dryRun;
  // NIGHTLY window is SMALL on purpose. This full-history-style scan only needs to
  // catch FRESH drops (a normalize outage / lost webhook in the last few days);
  // re-reading 90 days of a high-volume shop's orders every night (20k+) just to
  // find the 2-3 missing ones is what made the cron unable to finish. Aged drops
  // are healed by runIncidentDrivenHeal (which targets the flagged order_ids of
  // ANY age, bounded). A larger one-time drain is still available by passing an
  // explicit `days` (e.g. 90) to this function / the admin endpoint.
  const days = options.days && options.days > 0
    ? options.days
    : (Number(env.RECON_SWEEP_DAYS) || 3);
  const now = new Date();
  const fromIso = new Date(now.getTime() - days * 864e5).toISOString();
  const toIso = now.toISOString();
  // The FINALIZE pass stays on a short window even when CREATE drains 90 days.
  // Two reasons: (1) re-scanning every processed order over 90 days would make
  // the nightly run on high-volume auto_finalize shops (thousands of orders) slow
  // and subrequest-heavy for no gain — old invoices are already finalized; (2) IX
  // rejects backdated finalization, so a freshly-drained 50-day-old draft can't be
  // auto-finalized cleanly anyway — it's left as a draft for a human to finalize
  // with the right series/date strategy. Capped at RECON_SWEEP_DAYS (7).
  const finalizeDays = Math.min(days, Number(env.RECON_SWEEP_DAYS) || 7);
  const finalizeFromIso = new Date(now.getTime() - finalizeDays * 864e5).toISOString();

  // Allowlist: explicit option beats env; empty = all active shops.
  const envAllow = (env.RECON_SWEEP_SHOPS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const allow = options.shops?.length ? options.shops : envAllow;
  const allowSet = allow.length ? new Set(allow) : null;

  const root = new AppStorage(env);
  const active = await root.listActiveShopifyIntegrations();
  const selected = allowSet ? active.filter((s) => allowSet.has(s.shopify_domain)) : active;

  // Starvation fix. The loop below stops when the wall-clock budget runs out,
  // and the shop list arrives in a stable order — so the tail of the list was
  // never reached on a busy night, every night. Ordering by "least recently
  // completed" makes the budget rotate: whoever was starved last run goes first
  // this run. An explicit `shops` option keeps the caller's own order.
  const shops = options.shops?.length ? selected : await orderByStaleness(env, selected);

  // Resolve registered merchant names once (one query) so the report + incidents
  // read "Salted Books" / "Zoo de Lagos" instead of the raw myshopify slug.
  const nameByUser = await root.getMerchantDisplayNames(shops.map((s) => s.user_id));

  const result: ReconSweepResult = {
    ranAt: toIso,
    dryRun,
    window: { from: fromIso, to: toIso },
    shopsScanned: 0,
    totals: { created: 0, finalized: 0, skipped: 0, errors: 0, wouldCreate: 0, deferred: 0, skippedNoSubscription: 0 },
    perShop: [],
  };

  // Time budget: this full-history scan is a best-effort backstop (the
  // incident-driven heal is the reliable primary). Cap wall-clock so one
  // high-volume shop can't starve the rest of the fleet or blow the cron's
  // runtime; skipped shops are covered by incident-heal + the next run.
  const startMs = Date.now();
  const budgetMs = Number(env.RECON_SWEEP_BUDGET_MS) || 8 * 60 * 1000;
  /** What is left of the run's budget, so no single shop can spend it all. */
  const remainingBudgetMs = () => Math.max(0, budgetMs - (Date.now() - startMs));
  // Per-shop cap. A backlog is drained over several nights instead of choking on
  // it in one, and what is left over comes back as `deferred` rather than being
  // silently truncated.
  const maxOrdersPerShop = Number(env.RECON_SWEEP_MAX_ORDERS) || 25;
  const orderDeadlineMs = Number(env.RECON_SWEEP_ORDER_DEADLINE_MS) || 45_000;

  const skippedForBudget: string[] = [];
  for (const { shopify_domain } of shops) {
    if (!dryRun && Date.now() - startMs > budgetMs) {
      // Record every shop we did not get to. Previously this was a console
      // warning and nothing else, so a permanently-starved shop was
      // indistinguishable from a healthy one.
      const remaining = shops.slice(shops.findIndex((s) => s.shopify_domain === shopify_domain)).map((s) => s.shopify_domain);
      skippedForBudget.push(...remaining);
      console.warn(`[ReconSweep] time budget (${budgetMs}ms) reached; ${remaining.length} shop(s) not scanned this run: ${remaining.join(", ")}`);
      for (const dom of remaining) await markSweep(env, dom, "skipped_budget", { budgetMs });
      break;
    }
    const config = await new AppStorage(env, shopify_domain).loadConfig();
    if (!config) continue;
    // Defense-in-depth: never invoice a paused shop even if it slipped past the
    // enumeration filter (config edited between list and load).
    if (Number(config.is_paused) === 1) continue;
    result.shopsScanned++;

    const displayName = (config.user_id && nameByUser.get(config.user_id)) || shopify_domain;
    const row: ShopSweepRow = { shop: shopify_domain, displayName, created: 0, finalized: 0, skipped: 0, errors: 0, wouldCreate: 0, deferred: 0, errorSamples: [] };

    // The paywall has to be applied HERE too, or it is not a paywall.
    //
    // The live path refuses to invoice a shop without an active subscription
    // (checkSubscriptionGate, called from orders-created and generic-pipeline),
    // and then this sweep invoiced it anyway the same night, because it never
    // asked. Measured on 2026-09-02: every sale that entered a gate-blocked shop
    // since 01/09 had a document, and its author was `backfill` — this code.
    // The merchant saw an incident that resolved itself and a document a day
    // late, and nobody could explain either.
    //
    // Same function as the live path on purpose: two answers to "may we invoice
    // this shop?" is how they drift apart.
    const gate = await checkSubscriptionGate(env, config);
    if (!gate.allowed) {
      row.skippedNoSubscription = 1;
      result.totals.skippedNoSubscription++;
      result.perShop.push(row);
      await markSweep(env, shopify_domain, "skipped_no_subscription", { reason: gate.reason });
      continue;
    }

    try {
      // CREATE pass — reuses the double-guarded reemit path.
      //
      // The bounds are passed, not left to their defaults: without them one
      // shop's create pass can run for the whole 5-minute default budget and the
      // finalize pass for another, so a single high-volume shop overruns the
      // sweep's own 8-minute budget before it is next consulted — the outer
      // budget is only checked BETWEEN shops. That is why a 7-day sweep of a
      // busy shop never returned at all.
      const created = await processOrders(env, config, "create_orders", undefined, fromIso, toIso, {
        dry_run: dryRun,
        triggered_by: "recon-sweep-cron",
        reason: `Auto reconciliation sweep (${days}d window)`,
        max_orders: maxOrdersPerShop,
        budget_ms: remainingBudgetMs(),
        order_deadline_ms: orderDeadlineMs,
      });
      row.deferred += created.deferred ?? 0;
      row.created += created.success ?? 0;
      row.skipped += created.skipped ?? 0;
      row.errors += created.errors ?? 0;
      row.wouldCreate += created.would_create ?? 0;
      collectErrors(row, created.results);

      // FINALIZE pass — only for shops that auto-finalize (fiscal-validity parity).
      // Short window (finalizeFromIso), independent of the create drain window.
      // Check the budget again BEFORE the second pass, not only between shops:
      // the create pass above may have spent everything that was left.
      if (Number(config.auto_finalize) === 1 && (dryRun || remainingBudgetMs() > 0)) {
        const finalized = await processOrders(env, config, "finalize_orders", undefined, finalizeFromIso, toIso, {
          dry_run: dryRun,
          triggered_by: "recon-sweep-cron",
          reason: `Auto reconciliation sweep finalize (${finalizeDays}d window)`,
          max_orders: maxOrdersPerShop,
          budget_ms: remainingBudgetMs(),
          order_deadline_ms: orderDeadlineMs,
        });
        row.deferred += finalized.deferred ?? 0;
        row.finalized += finalized.success ?? 0;
        row.skipped += finalized.skipped ?? 0;
        row.errors += finalized.errors ?? 0;
        collectErrors(row, finalized.results);
      }
    } catch (e: any) {
      row.errors++;
      row.errorSamples.push({ order_number: 0, message: `sweep failed for shop: ${String(e?.message ?? e).slice(0, 300)}` });
    }

    // Escalate genuinely-stuck orders to the incidents table (daily bucket = one
    // row per shop/day). Not on dry-run — nothing was attempted.
    if (!dryRun && row.errors > 0) {
      try {
        await reportIncident(env, {
          user_id: config.user_id,
          severity: "error",
          kind: "queue_retry_exhausted",
          summary: `Reconciliation sweep: ${row.errors} order(s) could not be auto-invoiced for ${row.displayName}`.slice(0, 500),
          detail: {
            shop: shopify_domain, merchant: row.displayName, window: { from: fromIso, to: toIso }, errors: row.errorSamples,
            // The per-order reasons were nested inside `errors`, where the
            // triage redaction never looked — so the email carrying the most
            // diagnostic detail was the one the model called uninformative.
            message: summarizeErrorSamples(row.errorSamples),
          },
          // Use the Shopify order_id (what processed_orders is keyed by) so the
          // weekly digest can verify these against invoices and auto-close them
          // once healed. Fall back to order_number only when id is unknown
          // (shop-level sweep failure); drop the placeholder "0".
          affected_ids: row.errorSamples.map((s) => s.order_id ?? String(s.order_number)).filter((id) => id && id !== "0"),
          connection_label: "shopify → invoicexpress",
          merchant_name: row.displayName,
          bucket: "daily",
        });
      } catch (incErr: any) {
        console.error(`[ReconSweep] reportIncident failed for ${shopify_domain}: ${incErr?.message ?? incErr}`);
      }
    }

    result.totals.created += row.created;
    result.totals.finalized += row.finalized;
    result.totals.skipped += row.skipped;
    result.totals.errors += row.errors;
    result.totals.wouldCreate += row.wouldCreate;
    result.totals.deferred += row.deferred;
    result.perShop.push(row);

    // This shop got a full pass. Recording it is what lets the staleness check
    // below tell "nothing to heal" apart from "never ran".
    if (!dryRun) {
      // A shop the cap left work on is NOT a completed pass. Marking it "ok"
      // would reset last_completed_at, so a shop that is 25%-drained every night
      // for weeks would read as healthy and never trip reportStarvedShops.
      await markSweep(env, shopify_domain, sweepStatusFor(row), {
        created: row.created, finalized: row.finalized, errors: row.errors, deferred: row.deferred,
      });
    }
  }

  result.skippedForBudget = skippedForBudget;

  // No-monitoring contract: email ops ONLY when something can't be auto-fixed.
  // Silent on clean / all-healed runs. Never on dry-run.
  if (!dryRun && result.totals.errors > 0) {
    await notifyOps(env, result).catch((e) => console.error(`[ReconSweep] ops email failed: ${e?.message ?? e}`));
  }

  if (!dryRun) {
    await reportStarvedShops(env, shops.map((s) => s.shopify_domain), nameByUser, shops)
      .catch((e) => console.error(`[ReconSweep] staleness check failed: ${e?.message ?? e}`));
  }

  return result;
}

/**
 * Order shops by how long they have gone without a completed pass, oldest
 * first. A shop that has never completed one sorts to the very front.
 */
async function orderByStaleness<T extends { shopify_domain: string }>(env: Env, shops: T[]): Promise<T[]> {
  try {
    const rows = await env.DB.prepare("SELECT shopify_domain, last_completed_at FROM sweep_state").all();
    const seen = new Map<string, string>();
    for (const r of (rows.results ?? []) as any[]) {
      if (r?.shopify_domain) seen.set(String(r.shopify_domain), String(r.last_completed_at ?? ""));
    }
    return [...shops].sort((a, b) => (seen.get(a.shopify_domain) ?? "").localeCompare(seen.get(b.shopify_domain) ?? ""));
  } catch (e: any) {
    // Table missing (migration not applied yet) — keep the original order.
    console.warn(`[ReconSweep] staleness ordering unavailable: ${e?.message ?? e}`);
    return shops;
  }
}

export type SweepStatus = "ok" | "error" | "skipped_budget" | "skipped_no_subscription" | "partial";

/**
 * What this shop's pass was, in one word.
 *
 * `partial` exists because the per-shop cap made "we drained 25 of 141" possible,
 * and calling that `ok` is how a shop stays permanently behind while reading as
 * healthy: `ok` stamps `last_completed_at`, which is the clock the starvation
 * alert watches. Errors outrank a partial drain — an error needs a human either
 * way, and the deferred remainder will come back tomorrow on its own.
 */
export function sweepStatusFor(row: { errors: number; deferred: number }): SweepStatus {
  if (row.errors > 0) return "error";
  if (row.deferred > 0) return "partial";
  return "ok";
}

/**
 * Whether a status means "this shop was fully seen", which is the only thing
 * that may move `last_completed_at`. Everything else has to keep ageing.
 */
export function countsAsCompletion(status: SweepStatus): boolean {
  return status === "ok" || status === "error";
}

async function markSweep(env: Env, shop: string, status: SweepStatus, detail: unknown): Promise<void> {
  const nowIso = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO sweep_state (shopify_domain, last_started_at, last_completed_at, last_status, last_detail_json)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(shopify_domain) DO UPDATE SET
         last_started_at   = excluded.last_started_at,
         -- Only a full pass counts as a completion. A budget skip, a partial
         -- drain and a paywall skip all keep the previous timestamp, so the shop
         -- keeps ageing and eventually trips the starvation alert instead of
         -- reading as healthy while it is quietly never finished.
         last_completed_at = CASE WHEN excluded.last_status IN ('skipped_budget','partial','skipped_no_subscription')
                                  THEN sweep_state.last_completed_at
                                  ELSE excluded.last_completed_at END,
         last_status       = excluded.last_status,
         last_detail_json  = excluded.last_detail_json`
    ).bind(shop, nowIso, countsAsCompletion(status) ? nowIso : null, status, JSON.stringify(detail ?? null)).run();
  } catch (e: any) {
    console.warn(`[ReconSweep] markSweep(${shop}) failed: ${e?.message ?? e}`);
  }
}

/**
 * The part that makes the sweep trustworthy rather than best-effort: any live
 * shop that has not completed a pass in STALE_HOURS raises a critical incident.
 * Without this, a shop the budget never reaches heals nothing and says nothing.
 */
async function reportStarvedShops(
  env: Env,
  domains: string[],
  nameByUser: Map<string, string>,
  shops: Array<{ shopify_domain: string; user_id?: string | null }>,
): Promise<void> {
  const staleHours = Number(env.RECON_SWEEP_STALE_HOURS) || 48;
  const cutoff = new Date(Date.now() - staleHours * 3600000).toISOString();
  const rows = await env.DB.prepare("SELECT shopify_domain, last_completed_at FROM sweep_state").all();
  const completed = new Map<string, string | null>();
  for (const r of (rows.results ?? []) as any[]) completed.set(String(r.shopify_domain), r.last_completed_at ?? null);

  for (const shop of shops) {
    if (!domains.includes(shop.shopify_domain)) continue;
    const last = completed.get(shop.shopify_domain) ?? null;
    if (last && last >= cutoff) continue;
    const displayName = (shop.user_id && nameByUser.get(shop.user_id)) || shop.shopify_domain;
    await reportIncident(env, {
      user_id: shop.user_id ?? undefined,
      severity: "critical",
      kind: "queue_retry_exhausted",
      summary: `Sweep de reconciliação não completa há mais de ${staleHours}h para ${displayName} — faturas em falta podem não estar a ser recuperadas.`,
      detail: {
        shop: shop.shopify_domain, last_completed_at: last, stale_hours: staleHours,
        message: `O sweep de reconciliação desta loja não completa há mais de ${staleHours}h (última conclusão: ${last ?? "nunca"}). Não é uma recusa do destino — o próprio varrimento não está a correr até ao fim.`,
      },
      connection_label: "shopify → invoicexpress",
      merchant_name: displayName,
      bucket: "daily",
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Incident-driven auto-heal (the reliable nightly primary).
//
// WHY: the full 90-day history rescan (runReconciliationSweep) can't finish for
// high-volume shops (thousands of orders fetched per night just to find the 2-3
// that are missing), so those shops never auto-heal and a human ends up draining
// them by hand every week. This pass instead re-attempts EXACTLY the orders that
// already have an open invoice-failure incident — a small, bounded set that
// always completes. Every silent drop logs such an incident (queue retry
// exhausted / normalize fail / destination reject), so this heals them without
// re-reading the whole order history. The full scan stays on as a periodic
// backstop for the theoretical drop that never logged anything.
//
// Same safety as the sweep: guarded reemit path (no duplicates, drift-guarded),
// paid-only, paused shops skipped. Converges to zero work once healed (the
// weekly digest then auto-closes the now-invoiced incidents).
// ─────────────────────────────────────────────────────────────────────────────
export interface IncidentHealResult {
  ranAt: string;
  dryRun: boolean;
  shopsScanned: number;
  totals: { candidates: number; created: number; skipped: number; errors: number; wouldCreate: number; skippedNoSubscription: number };
  perShop: Array<{ shop: string; displayName: string; candidates: number; created: number; skipped: number; errors: number; wouldCreate: number; sampleIds: string[]; deferred?: number }>;
  /** Shops the wall-clock budget never reached. Empty = full coverage. */
  skippedForBudget?: string[];
}

export async function runIncidentDrivenHeal(env: Env, options: { dryRun?: boolean; shops?: string[] } = {}): Promise<IncidentHealResult> {
  const dryRun = !!options.dryRun;
  const now = new Date();
  const cutoffIso = new Date(now.getTime() - 90 * 864e5).toISOString();
  const root = new AppStorage(env);
  const active = await root.listActiveShopifyIntegrations();
  const allow = options.shops?.length ? new Set(options.shops) : null;
  const shops = allow ? active.filter((s) => allow.has(s.shopify_domain)) : active;
  const nameByUser = await root.getMerchantDisplayNames(shops.map((s) => s.user_id));

  const result: IncidentHealResult = {
    ranAt: now.toISOString(), dryRun, shopsScanned: 0,
    totals: { candidates: 0, created: 0, skipped: 0, errors: 0, wouldCreate: 0, skippedNoSubscription: 0 }, perShop: [],
  };
  const kindPh = INVOICE_FAILURE_KINDS.map(() => "?").join(",");

  // WHY these two bounds exist, learned the hard way on 2026-08-26: this pass
  // was written assuming "a small, bounded set that always completes", which
  // holds on a normal night and fails on exactly the night it is needed. Zoo de
  // Lagos hit its InvoiceXpress plan limit and accumulated ~200 failed orders;
  // the heal handed all 200 to processOrders in one call, at ~75s each, and the
  // cron invocation was killed long before it returned. Everything scheduled
  // AFTER it — the reconciliation sweep, the Stripe heal, the document verify
  // pass — therefore never ran, for five consecutive nights. The bigger the
  // outage, the more certainly the healer dies, so the outage never heals.
  //
  // So: stop starting new shops once the budget is spent, and drain a large
  // backlog across several nights instead of choking on it in one. What is left
  // is reported as `deferred`, not dropped silently.
  const healStartMs = Date.now();
  const healBudgetMs = Number(env.INCIDENT_HEAL_BUDGET_MS) || 4 * 60 * 1000;
  const maxPerShop = Number(env.INCIDENT_HEAL_MAX_ORDERS) || 25;
  const notReached: string[] = [];

  for (const { shopify_domain } of shops) {
    if (!dryRun && Date.now() - healStartMs > healBudgetMs) {
      notReached.push(shopify_domain);
      continue;
    }
    const config = await new AppStorage(env, shopify_domain).loadConfig();
    if (!config || Number(config.is_paused) === 1) continue;

    // Same paywall as the live path and the sweep. Healing a shop the gate is
    // refusing would re-invoice exactly what the gate declined, one night later.
    const healGate = await checkSubscriptionGate(env, config);
    if (!healGate.allowed) { result.totals.skippedNoSubscription++; continue; }

    // Open invoice-failure incidents for this merchant, within the reporting horizon.
    let incRows: any[] = [];
    try {
      const res = await env.DB.prepare(
        `SELECT affected_ids_json FROM incidents
         WHERE status IN ('open','acknowledged') AND user_id = ? AND last_seen_at >= ?
           AND kind IN (${kindPh})`
      ).bind(config.user_id, cutoffIso, ...INVOICE_FAILURE_KINDS).all();
      incRows = (res.results ?? []) as any[];
    } catch (e: any) {
      console.error(`[IncidentHeal] incident query failed for ${shopify_domain}: ${e?.message ?? e}`);
      continue;
    }

    // Collect Shopify order-IDs only (>=10 digits): excludes legacy order-numbers
    // and non-Shopify refs (pi_*, Lodgify booking ids). Post-fix incidents store
    // the order_id, so this is the healable set.
    const ids = new Set<string>();
    for (const r of incRows) {
      let arr: any[] = [];
      try { arr = JSON.parse(r.affected_ids_json || "[]"); } catch { /* skip malformed */ }
      for (const raw of arr) { const s = String(raw); if (/^\d{10,}$/.test(s)) ids.add(s); }
    }
    if (ids.size === 0) continue;

    result.shopsScanned++;
    const displayName = (config.user_id && nameByUser.get(config.user_id)) || shopify_domain;
    // Drop any already invoiced (via ANY mapping table) so we don't re-hit IX for them.
    const invoiced = await new AppStorage(env, shopify_domain).getInvoicedOrderIdsAnySource([...ids]);
    const missing = [...ids].filter((x) => !invoiced.has(x));
    const row = { shop: shopify_domain, displayName, candidates: missing.length, created: 0, skipped: 0, errors: 0, wouldCreate: 0, sampleIds: missing.slice(0, 10) };
    result.totals.candidates += missing.length;

    if (missing.length > 0) {
      const batch = missing.slice(0, maxPerShop);
      const deferred = missing.length - batch.length;
      if (deferred > 0) {
        (row as any).deferred = deferred;
        console.warn("[IncidentHeal] " + shopify_domain + ": healing " + batch.length + " of " + missing.length + "; " + deferred + " deferred to the next run.");
      }
      const numeric = batch.map(Number).filter((n) => Number.isFinite(n));
      try {
        const res = await processOrders(env, config, "create_orders", numeric, undefined, undefined, {
          dry_run: dryRun, paid_only: true, triggered_by: "incident-heal-cron", reason: "Incident-driven auto-heal",
        });
        row.created += res.success ?? 0;
        row.skipped += res.skipped ?? 0;
        row.errors += res.errors ?? 0;
        row.wouldCreate += res.would_create ?? 0;
      } catch (e: any) {
        row.errors++;
        console.error(`[IncidentHeal] processOrders failed for ${shopify_domain}: ${e?.message ?? e}`);
      }
    }
    result.totals.created += row.created;
    result.totals.skipped += row.skipped;
    result.totals.errors += row.errors;
    result.totals.wouldCreate += row.wouldCreate;
    result.perShop.push(row);
  }

  if (notReached.length) {
    result.skippedForBudget = notReached;
    console.warn("[IncidentHeal] time budget (" + healBudgetMs + "ms) reached; " + notReached.length + " shop(s) not reached: " + notReached.join(", "));
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stripe self-heal (Stripe→Moloni / IX / Vendus).
//
// WHY: the live Stripe path is sound — every succeeded payment fires
// payment_intent.succeeded, the pipeline creates one doc, and the duplicate
// charge.succeeded event dedups. But a doc can still end up MISSING after the
// fact: a draft deleted during setup/cleanup leaving the payment orphaned, or the
// rare webhook Stripe never manages to deliver. This is the automatic backstop —
// once a day it re-derives the truth from Stripe (succeeded PIs in the window) vs
// what we invoiced (processed_orders) and re-emits any gap.
//
// SAFETY (this is invoicing — it must not misfire):
//   • No duplicates. Only PIs with NO processed_orders row are re-emitted; the
//     re-emit itself runs the same guarded pipeline (D1 dedup + destination
//     findByReference). A payment that already has a doc is filtered out.
//   • Real destination. processStripeBackfill now routes to the connection's own
//     destination (Moloni/IX/Vendus), not a hardcoded one.
//   • Drafts preserved. auto_finalize is projected from the connection's config,
//     so a heal never finalizes a client that issues drafts (it stays a draft).
//   • Bounded. Stripe-source connections are low volume; a 30-day rescan filtered
//     to the un-invoiced few is cheap and always finishes.
// Fully additive, flag-gated (STRIPE_HEAL_ENABLED), reversible.
// ─────────────────────────────────────────────────────────────────────────────
export interface StripeHealResult {
  ranAt: string;
  dryRun: boolean;
  window: { from: string; to: string };
  connectionsScanned: number;
  totals: { created: number; skipped: number; errors: number; wouldCreate: number; connectionsSkipped: number };
  perConnection: Array<{ user_id: string; displayName: string; destination: string; from: string; created: number; skipped: number; errors: number; wouldCreate: number; errorSamples: string[]; note?: string }>;
}

export async function runStripeHeal(env: Env, options: { dryRun?: boolean; days?: number; users?: string[] } = {}): Promise<StripeHealResult> {
  const dryRun = !!options.dryRun;
  const days = options.days && options.days > 0 ? options.days : (Number(env.STRIPE_HEAL_DAYS) || 30);
  const now = new Date();
  const fromIso = new Date(now.getTime() - days * 864e5).toISOString();
  const toIso = now.toISOString();

  const root = new AppStorage(env);
  let conns = await root.listActiveConnections("stripe");
  // Allowlist: explicit option beats env; empty = all active Stripe connections.
  const envAllow = (env.STRIPE_HEAL_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const allow = options.users?.length ? options.users : envAllow;
  if (allow.length) { const allowSet = new Set(allow); conns = conns.filter((c) => allowSet.has(c.user_id)); }
  const nameByUser = await root.getMerchantDisplayNames(conns.map((c) => c.user_id));

  const result: StripeHealResult = {
    ranAt: toIso, dryRun, window: { from: fromIso, to: toIso },
    connectionsScanned: 0,
    totals: { created: 0, skipped: 0, errors: 0, wouldCreate: 0, connectionsSkipped: 0 },
    perConnection: [],
  };

  const fromMs = new Date(fromIso).getTime();

  for (const conn of conns) {
    result.connectionsScanned++;
    const displayName = nameByUser.get(conn.user_id) || conn.user_id;

    // CRITICAL safety bound: never heal payments from BEFORE the integration went
    // live. A Stripe account carries the merchant's whole payment history; a payment
    // predating the connection was invoiced manually/elsewhere (or intentionally not
    // at all), so re-emitting it would mint a DUPLICATE. Start the window no earlier
    // than the connection's invoice_cutoff (explicit) or its created_at (activation).
    const cutoffRaw = conn.invoice_cutoff ?? conn.created_at;
    const cutoffMs = cutoffRaw ? Date.parse(String(cutoffRaw).replace(" ", "T")) : NaN;
    const effFromIso = Number.isFinite(cutoffMs) && cutoffMs > fromMs ? new Date(cutoffMs).toISOString() : fromIso;

    const row = { user_id: conn.user_id, displayName, destination: conn.destination_kind, from: effFromIso, created: 0, skipped: 0, errors: 0, wouldCreate: 0, errorSamples: [] as string[], note: undefined as string | undefined };

    // Minimal config: processStripeBackfill + the pipeline resolve the real
    // destination, credentials and auto_finalize from the connection itself
    // (Stripe-only clients have no legacy `integrations` row). Mirrors the live
    // queue path's synthesized config.
    const config = { user_id: conn.user_id, shopify_domain: null, b2b_reverse_charge: 0, ix_send_email: 0, auto_finalize: 0 } as any;
    try {
      const r: any = await processStripeBackfill(env, config, {
        from: effFromIso, to: toIso, dry_run: dryRun,
        triggered_by: "stripe-heal-cron", reason: `Stripe auto-heal (since ${effFromIso.slice(0, 10)})`,
      });
      if (r?.error) {
        // A connection without saved Stripe credentials isn't a failure to alert on —
        // it's simply not ready. Skip it quietly instead of raising a nightly incident.
        if (/restricted_key|credentials/i.test(String(r.error))) {
          row.note = "skipped: no Stripe credentials on connection";
          result.totals.connectionsSkipped++;
        } else {
          row.errors++;
          row.errorSamples.push(String(r.error).slice(0, 300));
        }
      } else {
        row.created += r.success ?? 0;
        row.skipped += r.skipped ?? 0;
        row.errors += r.errors ?? 0;
        row.wouldCreate += r.would_create ?? 0;
        for (const res of (r.results ?? [])) {
          if (res.status === "error") row.errorSamples.push(`${res.external_id}: ${res.message}`.slice(0, 300));
        }
      }
    } catch (e: any) {
      row.errors++;
      row.errorSamples.push(`heal failed for connection: ${String(e?.message ?? e).slice(0, 300)}`);
    }

    // Escalate genuinely-stuck payments to the incidents table (daily bucket).
    // Not on dry-run — nothing was attempted.
    if (!dryRun && row.errors > 0) {
      try {
        await reportIncident(env, {
          user_id: conn.user_id,
          severity: "error",
          kind: "queue_retry_exhausted",
          summary: `Stripe auto-heal: ${row.errors} payment(s) could not be auto-invoiced for ${displayName}`.slice(0, 500),
          detail: {
            user_id: conn.user_id, merchant: displayName, destination: conn.destination_kind,
            window: { from: fromIso, to: toIso }, errors: row.errorSamples,
            message: summarizeErrorSamples(row.errorSamples),
          },
          connection_label: `stripe → ${conn.destination_kind}`,
          merchant_name: displayName,
          bucket: "daily",
        });
      } catch (incErr: any) {
        console.error(`[StripeHeal] reportIncident failed for ${conn.user_id}: ${incErr?.message ?? incErr}`);
      }
    }

    result.totals.created += row.created;
    result.totals.skipped += row.skipped;
    result.totals.errors += row.errors;
    result.totals.wouldCreate += row.wouldCreate;
    result.perConnection.push(row);
  }

  return result;
}

function collectErrors(row: ShopSweepRow, results: Array<{ order_id?: string | number; order_number: number; status: string; message: string }> | undefined) {
  for (const r of results ?? []) {
    if (r.status === "error") row.errorSamples.push({ order_number: r.order_number, order_id: r.order_id != null ? String(r.order_id) : undefined, message: String(r.message).slice(0, 300) });
  }
}

/**
 * The distinct reasons behind an aggregate sweep failure, as one sentence.
 *
 * A sweep incident covers many orders, and dozens of them usually failed on the
 * same thing — so the useful summary is the distinct reasons, not the first N.
 * Feeds `detail.message`, which is what the triage redaction reads.
 */
function summarizeErrorSamples(
  samples: Array<{ order_number?: number; message: string }> | string[] | undefined,
  max = 3,
): string | undefined {
  const texts = (samples ?? []).map((s) => (typeof s === "string" ? s : s.message)).filter(Boolean);
  if (texts.length === 0) return undefined;
  const distinct = Array.from(new Set(texts));
  const shown = distinct.slice(0, max).join(" | ");
  const rest = distinct.length - max;
  return `${texts.length} falha(s), ${distinct.length} motivo(s) distinto(s): ${shown}${rest > 0 ? ` (+${rest} outro(s))` : ""}`.slice(0, 1500);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function notifyOps(env: Env, result: ReconSweepResult): Promise<void> {
  const recipients = (env.KAPTA_DEV_EMAILS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (recipients.length === 0) return;

  const shopsWithErrors = result.perShop.filter((s) => s.errors > 0);
  const blocks = shopsWithErrors.map((s) => {
    const items = s.errorSamples.slice(0, 10)
      .map((e) => `<li><strong>#${e.order_number}</strong>: ${escapeHtml(e.message)}</li>`)
      .join("");
    return `<h3 style="margin:16px 0 4px">${escapeHtml(s.displayName)} <span style="color:#94a3b8;font-weight:normal">(${escapeHtml(s.shop)})</span> — ${s.errors} order(s) need attention</h3><ul>${items}</ul>`;
  }).join("");

  const html = `
    <h2>Reconciliation sweep — orders that could not be auto-invoiced</h2>
    <p>Window ${escapeHtml(result.window.from)} → ${escapeHtml(result.window.to)}.<br>
    Auto-created ${result.totals.created}, finalized ${result.totals.finalized},
    skipped ${result.totals.skipped}, <strong>errors ${result.totals.errors}</strong>
    across ${result.shopsScanned} shop(s).</p>
    ${blocks}
    <p style="color:#64748b">These need a human: usually a total mismatch (drift — check the order against what was paid) or an upstream service still down (the next sweep retries automatically). Everything else was invoiced without you having to do anything.</p>`;

  await sendEmail(env, {
    to: recipients,
    subject: `Rioko reconciliation sweep — ${result.totals.errors} order(s) need attention`,
    html,
  });
}
