import type { Env } from "../env";
import { resolveConnectionContext } from "../services/connection-context";
import { buildAdapterCtx } from "../services/adapter-ctx";
import { getDestinationAdapter } from "../adapters/registry";
import { mapWithConcurrency } from "../services/concurrency";
import { verifyCreatedDocument } from "../services/document-verify";
import { takeLostWriteCount } from "../services/document-log";
import { reportIncident } from "../services/incidents";

/**
 * Hold every document we issued to what we said we were issuing.
 *
 * This runs in the 04:00 cron rather than at creation time, and that is a
 * deliberate trade rather than a convenience. Verifying inline costs one read of
 * the destination per document, and `runAdapterPipeline` is called in a LOOP by
 * the reconciliation sweep and by every admin backfill — so a hundred-order
 * backfill fired a hundred extra reads at ix-proxy in a burst, which is the
 * precise shape that took it down before (see `mapWithConcurrency`).
 *
 * Deferring costs something too: by 04:00 the intent is gone. That is why the
 * create paths write a `built` event carrying what they sent — one local D1
 * insert, no network — and this sweep reads it back and compares it with what
 * the destination is holding.
 *
 * Candidate selection IS the idempotency: a document with a `verified` or
 * `drift` row is never picked again, and one whose read failed simply comes back
 * tomorrow.
 */

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_BUDGET_MS = 8 * 60 * 1000;

export interface DocVerifySweepOptions {
  dryRun?: boolean;
  /** How far back to look for unverified documents. Widen this to backfill. */
  days?: number;
  /** Restrict to these user_ids / shop domains. Empty = the whole fleet. */
  scopes?: string[];
  /** Hard cap on documents examined in one run. */
  limit?: number;
  /**
   * Verify documents issued before this log existed, taken from
   * `processed_orders` instead of `built` events. Only the exemption code can be
   * compared — see historicalDocumentsSql.
   */
  history?: boolean;
}

export interface DocVerifySweepResult {
  ranAt: string;
  dryRun: boolean;
  window: { from: string; days: number };
  candidates: number;
  checked: number;
  matched: number;
  drifted: number;
  unreadable: number;
  contextsFailed: number;
  budgetExhausted: boolean;
  drifts: Array<{ externalId: string; invoiceId: string; fields: string[] }>;
}

interface Candidate {
  externalId: string;
  invoiceId: string;
  userId: string | null;
  shopifyDomain: string | null;
  sourceKind: string | null;
  destinationKind: string | null;
  intent: { total?: number | null; reference?: string | null; exemptionCode?: string | null };
}

/**
 * Documents issued BEFORE this log existed, so there is no recorded intent.
 *
 * Most of what verification compares is therefore unavailable: we cannot know
 * what total or reference we sent for a sale from three months ago without
 * re-fetching it from the source, which is the reconciliation's job and not
 * worth duplicating.
 *
 * One field survives that gap. The VAT-exemption code is not per-sale — it is
 * the shop's configured regime, so for a historical document the config IS the
 * intent. That is enough to catch the drift we already know about (lliberta
 * 11/LL was sent M10 and InvoiceXpress holds M99) and any other shop quietly
 * declaring the wrong regime, across every document ever issued.
 */
export function historicalDocumentsSql(scopeCount = 0): string {
  return `
    SELECT p.id AS external_id, p.invoice_id, p.user_id, p.shopify_domain,
           p.source_kind, p.destination_kind
      FROM processed_orders p
     WHERE p.invoice_id IS NOT NULL
       AND p.created_at >= ?
       ${scopeFilterSql("p", scopeCount)}
       AND NOT EXISTS (
             SELECT 1 FROM document_events v
              WHERE v.invoice_id = p.invoice_id
                -- drift_lead counts as a verdict HERE: an unconfirmed lead is
                -- resolved by a person, not by re-reading the same document on
                -- every history run.
                AND v.event IN ('verified', 'drift', 'drift_lead')
           )
     ORDER BY p.created_at DESC
     LIMIT ?`;
}

/**
 * Narrowing by merchant has to happen IN the query, not over its results.
 *
 * Filtering afterwards means the LIMIT is spent on the whole fleet first: a run
 * aimed at one small shop scanned the newest 500 documents across every merchant
 * and came back with one of that shop's three. Targeted runs are how this gets
 * verified before it is trusted, so they have to actually target.
 */
function scopeFilterSql(alias: string, scopeCount: number): string {
  if (scopeCount <= 0) return "";
  const ph = new Array(scopeCount).fill("?").join(", ");
  return `AND (${alias}.shopify_domain IN (${ph}) OR ${alias}.user_id IN (${ph}))`;
}

/**
 * Documents that carry a recorded intent and no verdict yet — the normal path.
 *
 * Exported so the selection rule can be read (and tested) on its own rather than
 * being buried in a template literal, the same reason the retention SQL is a
 * function.
 */
export function unverifiedDocumentsSql(scopeCount = 0): string {
  return `
    SELECT b.external_id, b.invoice_id, b.user_id, b.shopify_domain,
           b.source_kind, b.destination_kind, b.detail_json
      FROM document_events b
     WHERE b.event = 'built'
       AND b.invoice_id IS NOT NULL
       AND b.created_at >= ?
       ${scopeFilterSql("b", scopeCount)}
       AND NOT EXISTS (
             SELECT 1 FROM document_events v
              WHERE v.invoice_id = b.invoice_id
                AND v.event IN ('verified', 'drift')
           )
     ORDER BY b.created_at ASC
     LIMIT ?`;
}

export async function runDocumentVerifySweep(
  env: Env,
  options: DocVerifySweepOptions = {},
): Promise<DocVerifySweepResult> {
  const dryRun = !!options.dryRun;
  const days = options.days && options.days > 0 ? options.days : (Number(env.DOC_VERIFY_DAYS) || 3);
  const limit = Math.min(options.limit ?? Number(env.DOC_VERIFY_LIMIT) ?? 500, 2000);
  const fromIso = new Date(Date.now() - days * 864e5).toISOString();
  const startMs = Date.now();
  const budgetMs = Number(env.DOC_VERIFY_BUDGET_MS) || DEFAULT_BUDGET_MS;

  const result: DocVerifySweepResult = {
    ranAt: new Date().toISOString(),
    dryRun,
    window: { from: fromIso, days },
    candidates: 0,
    checked: 0,
    matched: 0,
    drifted: 0,
    unreadable: 0,
    contextsFailed: 0,
    budgetExhausted: false,
    drifts: [],
  };

  const history = !!options.history;
  const scopes = (options.scopes ?? []).filter(Boolean);
  const rows = await env.DB
    .prepare(history ? historicalDocumentsSql(scopes.length) : unverifiedDocumentsSql(scopes.length))
    // The scope list is bound twice — once for shopify_domain, once for user_id.
    .bind(fromIso, ...scopes, ...scopes, limit)
    .all();

  const candidates: Candidate[] = [];
  for (const r of (rows.results ?? []) as any[]) {
    let intent: Candidate["intent"] = {};
    try {
      intent = (JSON.parse(String(r.detail_json ?? "{}"))?.intent ?? {}) as Candidate["intent"];
    } catch { /* a built row we cannot parse still tells us the document exists */ }
    candidates.push({
      externalId: String(r.external_id),
      invoiceId: String(r.invoice_id),
      userId: r.user_id != null ? String(r.user_id) : null,
      shopifyDomain: r.shopify_domain != null ? String(r.shopify_domain) : null,
      sourceKind: r.source_kind != null ? String(r.source_kind) : null,
      destinationKind: r.destination_kind != null ? String(r.destination_kind) : null,
      intent,
    });
  }
  result.candidates = candidates.length;

  // Group by merchant so credentials, product mappings and tag rules are
  // resolved once per connection instead of once per document.
  const byScope = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = c.shopifyDomain ?? c.userId ?? "unknown";
    const list = byScope.get(key) ?? [];
    list.push(c);
    byScope.set(key, list);
  }

  for (const [scopeKey, group] of byScope) {
    if (Date.now() - startMs > budgetMs) {
      // Whatever is left keeps its `built` row and no verdict, so tomorrow's run
      // picks it up first — the selection is ordered oldest-built.
      result.budgetExhausted = true;
      console.warn(`[DocVerify] budget ${budgetMs}ms reached; ${byScope.size} scope(s) planned, stopping at ${scopeKey}`);
      break;
    }

    const first = group[0];
    const resolved = await resolveConnectionContext(env, {
      shop: first.shopifyDomain,
      userId: first.userId,
      onAmbiguous: "pick_latest",
    });
    if (!resolved.ok) {
      result.contextsFailed++;
      console.warn(`[DocVerify] no connection context for ${scopeKey} — ${group.length} document(s) left unverified`);
      continue;
    }

    const connCtx = resolved.ctx;
    const adapter = getDestinationAdapter(connCtx.destination);
    // Vendus cannot read a document back at all, so there is nothing to hold it
    // to. Skipping loudly beats writing a verdict we did not earn.
    if (!adapter.getDocument) {
      console.log(`[DocVerify] ${connCtx.destination} cannot read documents back — skipping ${group.length} for ${scopeKey}`);
      continue;
    }

    const { ctx } = await buildAdapterCtx(env, {
      config: connCtx.config,
      source: connCtx.source,
      destination: connCtx.destination,
      sourceConfig: connCtx.sourceConfig,
      destinationConfig: connCtx.destinationConfig,
    });

    if (dryRun) {
      result.checked += group.length;
      continue;
    }

    await mapWithConcurrency(group, DEFAULT_CONCURRENCY, async (c) => {
      if (Date.now() - startMs > budgetMs) return;
      const outcome = await verifyCreatedDocument({
        env,
        adapter,
        ctx,
        invoiceId: c.invoiceId,
        externalId: c.externalId,
        intent: {
          total: c.intent.total ?? null,
          reference: c.intent.reference ?? null,
          exemptionCode: c.intent.exemptionCode ?? null,
          // History has no recorded intent, so the exact code we sent is gone.
          // What IS knowable is the set the shop could legitimately have used:
          // its generic code, or its B2B one when the order carried a
          // reverse-charge exemption (which is a property of the ORDER, not the
          // config — see detectShopifyReverseCharge). A stored code outside that
          // set could not have come from this shop's configuration at all, and
          // that is the only claim worth making from here.
          acceptableExemptionCodes: c.intent.exemptionCode
            ? null
            : [connCtx.config.ix_exemption_reason, connCtx.config.ix_b2b_exemption_reason]
                .filter((v): v is string => !!v),
        },
        userId: c.userId,
        shopifyDomain: c.shopifyDomain,
        sourceKind: c.sourceKind,
        destinationKind: c.destinationKind,
        actor: "cron:document-verify",
        orderRef: c.externalId,
        // In history mode a mismatch is a `drift_lead`, not a `drift`: the
        // acceptable set above is today's config, and config changes over time.
        historical: history,
      }).catch((e: any) => {
        console.error(`[DocVerify] ${c.invoiceId} threw: ${e?.message ?? e}`);
        return { checked: false, drifts: [] as any[] };
      });

      result.checked++;
      if (!outcome.checked) { result.unreadable++; return; }
      if (outcome.drifts.length === 0) { result.matched++; return; }
      result.drifted++;
      result.drifts.push({
        externalId: c.externalId,
        invoiceId: c.invoiceId,
        fields: outcome.drifts.map((d: any) => d.field),
      });
    });
  }

  // A log that loses rows in silence is the bug this table exists to end, so a
  // lost write is escalated rather than left as a console line in a Worker
  // nobody tails.
  const lost = takeLostWriteCount();
  if (lost > 0 && !dryRun) {
    try {
      await reportIncident(env, {
        user_id: null,
        severity: "error",
        kind: "queue_retry_exhausted",
        bucket: "daily",
        summary: `O registo de documentos perdeu ${lost} escrita(s) — o histórico desta janela está incompleto.`,
        detail: {
          lost, window: result.window,
          message: `${lost} escrita(s) no registo de documentos falharam nesta janela (desde ${result.window?.from ?? "?"}, ${result.window?.days ?? "?"} dia(s)). Não é uma recusa do destino: as gravações em D1 é que não passaram, pelo que o histórico desta janela está incompleto.`,
        },
      });
    } catch (e: any) {
      console.error(`[DocVerify] could not report ${lost} lost log write(s): ${e?.message ?? e}`);
    }
  }

  console.log(
    `[DocVerify] candidates=${result.candidates} checked=${result.checked} matched=${result.matched} `
    + `drifted=${result.drifted} unreadable=${result.unreadable} contextsFailed=${result.contextsFailed}`
    + (result.budgetExhausted ? " (budget exhausted)" : ""),
  );
  return result;
}
