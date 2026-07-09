import type { Env } from "../env";
import { AppStorage } from "../storage";
import { processOrders } from "./admin";
import { reportIncident } from "../services/incidents";
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
  // Window must match the weekly-digest horizon (WEEKLY_LOOKBACK_DAYS=90): a drop
  // reported as "por emitir" for up to 90 days but only re-fetched for 7 days is
  // the root cause of backlogs that get flagged forever yet never auto-heal.
  // Widened to a 90-day drain. The fetch is cheap (paginated Shopify list); the
  // expensive IX work self-limits to genuinely-missing orders (dedup vs
  // processed_orders + adminCreateOrder's IX-by-reference guard syncs phantoms
  // instead of double-invoicing), so a healed shop converges to ~0 work per run.
  const days = options.days && options.days > 0
    ? options.days
    : (Number(env.RECON_SWEEP_DRAIN_DAYS) || Number(env.RECON_SWEEP_DAYS) || 90);
  const now = new Date();
  const fromIso = new Date(now.getTime() - days * 864e5).toISOString();
  const toIso = now.toISOString();

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

  for (const { shopify_domain } of shops) {
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
      if (Number(config.auto_finalize) === 1) {
        const finalized = await processOrders(env, config, "finalize_orders", undefined, fromIso, toIso, {
          dry_run: dryRun,
          triggered_by: "recon-sweep-cron",
          reason: `Auto reconciliation sweep finalize (${days}d window)`,
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
