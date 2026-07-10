import type { Env } from "../env";
import { AppStorage } from "../storage";
import { processOrders } from "./admin";
import { reportIncident, INVOICE_FAILURE_KINDS } from "../services/incidents";
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
  errorSamples: Array<{ order_number: number; order_id?: string; message: string }>;
}

export interface ReconSweepResult {
  ranAt: string;
  dryRun: boolean;
  window: { from: string; to: string };
  shopsScanned: number;
  totals: { created: number; finalized: number; skipped: number; errors: number; wouldCreate: number };
  perShop: ShopSweepRow[];
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
  const shops = allowSet ? active.filter((s) => allowSet.has(s.shopify_domain)) : active;

  // Resolve registered merchant names once (one query) so the report + incidents
  // read "Salted Books" / "Zoo de Lagos" instead of the raw myshopify slug.
  const nameByUser = await root.getMerchantDisplayNames(shops.map((s) => s.user_id));

  const result: ReconSweepResult = {
    ranAt: toIso,
    dryRun,
    window: { from: fromIso, to: toIso },
    shopsScanned: 0,
    totals: { created: 0, finalized: 0, skipped: 0, errors: 0, wouldCreate: 0 },
    perShop: [],
  };

  // Time budget: this full-history scan is a best-effort backstop (the
  // incident-driven heal is the reliable primary). Cap wall-clock so one
  // high-volume shop can't starve the rest of the fleet or blow the cron's
  // runtime; skipped shops are covered by incident-heal + the next run.
  const startMs = Date.now();
  const budgetMs = Number(env.RECON_SWEEP_BUDGET_MS) || 8 * 60 * 1000;

  for (const { shopify_domain } of shops) {
    if (!dryRun && Date.now() - startMs > budgetMs) {
      console.warn(`[ReconSweep] time budget (${budgetMs}ms) reached; skipping remaining shops this run`);
      break;
    }
    const config = await new AppStorage(env, shopify_domain).loadConfig();
    if (!config) continue;
    // Defense-in-depth: never invoice a paused shop even if it slipped past the
    // enumeration filter (config edited between list and load).
    if (Number(config.is_paused) === 1) continue;
    result.shopsScanned++;

    const displayName = (config.user_id && nameByUser.get(config.user_id)) || shopify_domain;
    const row: ShopSweepRow = { shop: shopify_domain, displayName, created: 0, finalized: 0, skipped: 0, errors: 0, wouldCreate: 0, errorSamples: [] };

    try {
      // CREATE pass — reuses the double-guarded reemit path.
      const created = await processOrders(env, config, "create_orders", undefined, fromIso, toIso, {
        dry_run: dryRun,
        triggered_by: "recon-sweep-cron",
        reason: `Auto reconciliation sweep (${days}d window)`,
      });
      row.created += created.success ?? 0;
      row.skipped += created.skipped ?? 0;
      row.errors += created.errors ?? 0;
      row.wouldCreate += created.would_create ?? 0;
      collectErrors(row, created.results);

      // FINALIZE pass — only for shops that auto-finalize (fiscal-validity parity).
      // Short window (finalizeFromIso), independent of the create drain window.
      if (Number(config.auto_finalize) === 1) {
        const finalized = await processOrders(env, config, "finalize_orders", undefined, finalizeFromIso, toIso, {
          dry_run: dryRun,
          triggered_by: "recon-sweep-cron",
          reason: `Auto reconciliation sweep finalize (${finalizeDays}d window)`,
        });
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
          detail: { shop: shopify_domain, merchant: row.displayName, window: { from: fromIso, to: toIso }, errors: row.errorSamples },
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
    result.perShop.push(row);
  }

  // No-monitoring contract: email ops ONLY when something can't be auto-fixed.
  // Silent on clean / all-healed runs. Never on dry-run.
  if (!dryRun && result.totals.errors > 0) {
    await notifyOps(env, result).catch((e) => console.error(`[ReconSweep] ops email failed: ${e?.message ?? e}`));
  }

  return result;
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
  totals: { candidates: number; created: number; skipped: number; errors: number; wouldCreate: number };
  perShop: Array<{ shop: string; displayName: string; candidates: number; created: number; skipped: number; errors: number; wouldCreate: number; sampleIds: string[] }>;
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
    totals: { candidates: 0, created: 0, skipped: 0, errors: 0, wouldCreate: 0 }, perShop: [],
  };
  const kindPh = INVOICE_FAILURE_KINDS.map(() => "?").join(",");

  for (const { shopify_domain } of shops) {
    const config = await new AppStorage(env, shopify_domain).loadConfig();
    if (!config || Number(config.is_paused) === 1) continue;

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
      const numeric = missing.map(Number).filter((n) => Number.isFinite(n));
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

  return result;
}

function collectErrors(row: ShopSweepRow, results: Array<{ order_id?: string | number; order_number: number; status: string; message: string }> | undefined) {
  for (const r of results ?? []) {
    if (r.status === "error") row.errorSamples.push({ order_number: r.order_number, order_id: r.order_id != null ? String(r.order_id) : undefined, message: String(r.message).slice(0, 300) });
  }
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
