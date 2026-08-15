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
 * Documents that carry a recorded intent and no verdict yet.
 *
 * Exported so the selection rule can be read (and tested) on its own rather than
 * being buried in a template literal — the same reason the retention SQL is a
 * function.
 */
export function unverifiedDocumentsSql(): string {
  return `
    SELECT b.external_id, b.invoice_id, b.user_id, b.shopify_domain,
           b.source_kind, b.destination_kind, b.detail_json
      FROM document_events b
     WHERE b.event = 'built'
       AND b.invoice_id IS NOT NULL
       AND b.created_at >= ?
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

  const rows = await env.DB.prepare(unverifiedDocumentsSql()).bind(fromIso, limit).all();

  const allowed = new Set((options.scopes ?? []).filter(Boolean));
  const candidates: Candidate[] = [];
  for (const r of (rows.results ?? []) as any[]) {
    const scopeKey = r.shopify_domain ?? r.user_id ?? "";
    if (allowed.size > 0 && !allowed.has(scopeKey)) continue;
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
          // Falls back to the shop's configured exemption code when the built
          // row carried none. That is what catches the drift we already know
          // about: lliberta 11/LL was sent M10 and InvoiceXpress holds M99.
          exemptionCode: c.intent.exemptionCode ?? connCtx.config.ix_exemption_reason ?? null,
        },
        userId: c.userId,
        shopifyDomain: c.shopifyDomain,
        sourceKind: c.sourceKind,
        destinationKind: c.destinationKind,
        actor: "cron:document-verify",
        orderRef: c.externalId,
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
        detail: { lost, window: result.window },
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
