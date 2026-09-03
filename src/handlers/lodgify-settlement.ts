import type { Env } from "../env";
import type { IRequestConfig, DestinationKind } from "../storage";
import { AppStorage, type SettlementState } from "../storage";
import { getDestinationAdapter } from "../adapters/registry";
import { buildAdapterCtx } from "../services/adapter-ctx";
import { bookingCollectedAmount, partialModeFrom } from "../services/lodgify-amounts";
import { channelReference } from "../services/lodgify-booking";
import { saleReference } from "../services/document-references";
import { reportIncident } from "../services/incidents";
import { logDocumentEvent } from "../services/document-log";

/**
 * Recording the money, once the Fatura exists.
 *
 * The other half of `invoice_plus_receipts`: a part-paid stay is invoiced in
 * full as a Fatura — a Fatura states a debt, so issuing it while half the money
 * is outstanding is honest — and each payment is then recorded against it as a
 * Recibo. This is that second half, and it CANNOT be part of issuing: Moloni
 * only associates a Recibo to a CLOSED document, so it runs after the finalize
 * pass and again whenever the next payment lands.
 *
 * Called by the Lodgify poll (every 30 minutes, on the bookings it just fetched)
 * and by POST /admin/lodgify/settle-receipts, which is the same function with a
 * dry run in front of it. One implementation, because a manual path that drifts
 * from the automatic one is how both settlement bugs in this integration got
 * their second life.
 */

const MAX_DOCS_DEFAULT = 40;
/** How long a draft awaiting the merchant's approval is left alone. */
const DRAFT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
/** A document the destination cannot find: try, back off, then park it. */
const MISSING_MAX_ATTEMPTS = 3;

export interface SettleRow {
  booking_id: string;
  invoice_id: string;
  guest?: string | null;
  collected?: number;
  status: string;
  message: string;
  receipt_id?: string;
  value?: number;
}

export interface SettleResult {
  scanned: number;
  settled: number;
  skipped: number;
  blocked: number;
  errors: number;
  rows: SettleRow[];
}

/**
 * Is this document worth asking Moloni about on this pass?
 *
 * Pure, and the whole cost model: without it the pass re-reads every document
 * the merchant has ever been invoiced for, every half hour, for the two receipts
 * a month it actually issues. Every input is a cached copy of an answer someone
 * already gave — the amount is never decided here.
 */
export function shouldAskDestination(
  state: SettlementState | undefined,
  collected: number,
  nowMs: number,
): boolean {
  // Never seen: ask once, whatever it says.
  if (!state) return true;
  // A guard refused it or a receipt did not reconcile. Only a human clears this.
  if (state.needsHuman) return false;
  // The merchant recorded more money than we last saw. This is the event the
  // whole pass exists to react to.
  if (state.lastCollected == null || collected > state.lastCollected + 0.01) return true;
  // Still a draft last time — the merchant may have approved it since, but that
  // is worth one look every few hours, not 48 a day.
  if (state.docStatus !== 1) {
    if (!state.nextCheckAt) return true;
    return Date.parse(state.nextCheckAt) <= nowMs;
  }
  // Closed, and Moloni's own reconciled figure already covers what came in.
  if (state.lastSettled != null && state.docTotal != null) {
    const target = Math.min(collected, state.docTotal);
    return state.lastSettled + 0.01 < target;
  }
  return true;
}

/** The references the create path may have written for this booking. */
function referencesFor(bookingId: string): string[] {
  const numeric = Number(String(bookingId).replace(/\D/g, "").slice(-12)) || 0;
  return numeric > 0 ? [saleReference(numeric)] : [];
}

export interface SettleOptions {
  userId: string;
  destination: DestinationKind;
  config: IRequestConfig;
  sourceCfg?: Record<string, any>;
  destinationConfig?: Record<string, any>;
  connLabel: string;
  /**
   * The booking items the poll just fetched from Lodgify. Preferred over the
   * mirror: "how much came in" and "is this still Booked" then come from data
   * we can vouch for this minute, and a stale mirror still reading `Booked` on a
   * cancelled stay is the one path that puts a Recibo on a cancelled booking.
   */
  items?: any[];
  /** Admin path: settle only these bookings. */
  bookingIds?: string[];
  dryRun: boolean;
  /** Admin path: the items came from the mirror, so their freshness is checked. */
  mirrorSourced?: boolean;
  limit?: number;
  actor?: string;
}

export async function settleLodgifyReceipts(env: Env, o: SettleOptions): Promise<SettleResult> {
  const result: SettleResult = { scanned: 0, settled: 0, skipped: 0, blocked: 0, errors: 0, rows: [] };

  if (partialModeFrom(o.destinationConfig) !== "invoice_plus_receipts") return result;
  const adapter = getDestinationAdapter(o.destination);
  if (!adapter.settleDocument) return result;

  const storage = new AppStorage(env, null, o.userId);
  const limit = Math.min(o.limit ?? MAX_DOCS_DEFAULT, 100);
  const wanted = new Set((o.bookingIds ?? []).map((b) => String(b)));

  // Everything we have issued for this connection, with the mirror row beside
  // it. The mirror supplies the guest name and, on the admin path, the amounts.
  const rows = ((await env.DB.prepare(
    `SELECT p.id AS booking_id, p.invoice_id, b.raw_json, b.guest_name, b.synced_at
       FROM processed_orders p
       LEFT JOIN lodgify_bookings b ON b.user_id = p.user_id AND b.id = p.id
      WHERE p.user_id = ? AND p.source_kind = 'lodgify' AND p.invoice_id IS NOT NULL`
  ).bind(o.userId).all())?.results ?? []) as any[];
  if (rows.length === 0) return result;

  // Fresh items win over mirrored ones, keyed by booking id.
  const fresh = new Map<string, any>();
  for (const item of o.items ?? []) {
    const id = String(item?.id ?? item?.booking_id ?? "");
    if (id) fresh.set(id, item);
  }

  const state = await storage.listSettlementState(o.userId);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  interface Candidate { bookingId: string; invoiceId: string; item: any; guest: string | null; collected: number }
  const candidates: Candidate[] = [];

  for (const row of rows) {
    const bookingId = String(row.booking_id);
    if (wanted.size > 0 && !wanted.has(bookingId)) continue;

    let item = fresh.get(bookingId);
    let fromMirror = false;
    if (!item) {
      try { item = row.raw_json ? JSON.parse(row.raw_json) : null; } catch { item = null; }
      fromMirror = true;
    }
    if (!item) {
      // No statement of what came in. Guessing "paid in full" here would receipt
      // money nobody received.
      result.rows.push({ booking_id: bookingId, invoice_id: String(row.invoice_id), status: "skipped", message: "sem reserva conhecida — não sei quanto entrou" });
      result.skipped++;
      continue;
    }

    // A stay that stopped being Booked must not be receipted. The cancellation
    // path deliberately keeps the processed_orders row when the document is
    // already certified, so a naive join reaches exactly those.
    const status = String(item?.status ?? "").toLowerCase();
    if (status !== "booked") {
      result.rows.push({ booking_id: bookingId, invoice_id: String(row.invoice_id), status: "skipped", message: `reserva ${item?.status ?? "sem estado"} — não liquido` });
      result.skipped++;
      continue;
    }

    // Mirror rows age. On the automatic path freshness is structural (a failed
    // Lodgify list makes the poll skip this connection before we run), so this
    // only guards the admin path.
    if (fromMirror && o.mirrorSourced) {
      const synced = Date.parse(String(row.synced_at ?? "").replace(" ", "T") + "Z");
      if (!Number.isFinite(synced) || nowMs - synced > 6 * 60 * 60 * 1000) {
        result.rows.push({ booking_id: bookingId, invoice_id: String(row.invoice_id), status: "skipped", message: "espelho com mais de 6h — corra o poll antes de liquidar" });
        result.skipped++;
        continue;
      }
    }

    const { collected } = bookingCollectedAmount(item);
    const key = `${bookingId}:${row.invoice_id}`;
    const known = state.get(key);
    if (!shouldAskDestination(known, collected, nowMs)) {
      if (known?.needsHuman) {
        result.rows.push({ booking_id: bookingId, invoice_id: String(row.invoice_id), status: "blocked", message: known.lastMessage ?? "marcado para verificação humana" });
        result.blocked++;
      }
      continue;
    }

    candidates.push({ bookingId, invoiceId: String(row.invoice_id), item, guest: row.guest_name ?? null, collected });
    if (candidates.length >= limit) break;
  }

  if (candidates.length === 0) return result;

  const { ctx } = await buildAdapterCtx(env, {
    config: o.config,
    source: "lodgify",
    destination: o.destination,
    sourceConfig: o.sourceCfg,
    destinationConfig: o.destinationConfig,
  });

  for (const c of candidates) {
    result.scanned++;
    const base = { booking_id: c.bookingId, invoice_id: c.invoiceId, guest: c.guest, collected: c.collected };

    // Fail-closed: an unreachable claim table means "do not settle". The
    // alternative here is a second certified Recibo, which only a human undoes.
    if (!o.dryRun && !(await storage.claimSettlement(o.userId, c.invoiceId))) {
      result.rows.push({ ...base, status: "skipped", message: "outra corrida está a liquidar este documento" });
      result.skipped++;
      continue;
    }

    try {
      const outcome = await adapter.settleDocument!(c.invoiceId, ctx, {
        collected: c.collected,
        channelReference: channelReference(c.item),
        expectedReferences: referencesFor(c.bookingId),
        notes: `Reserva LOD-${c.bookingId}`,
        dryRun: o.dryRun,
      });

      result.rows.push({
        ...base,
        status: outcome.status,
        message: outcome.message,
        ...("receiptId" in outcome ? { receipt_id: outcome.receiptId } : {}),
        ...("value" in outcome ? { value: outcome.value } : {}),
      });

      if (o.dryRun) continue;

      const next: SettlementState = {
        bookingId: c.bookingId,
        invoiceId: c.invoiceId,
        docStatus: outcome.doc?.status ?? null,
        docTotal: outcome.doc?.total ?? null,
        lastCollected: c.collected,
        lastSettled: outcome.doc?.reconciled ?? null,
        lastReceiptId: "receiptId" in outcome ? outcome.receiptId : null,
        needsHuman: false,
        attempts: 0,
        lastCheckedAt: nowIso,
        nextCheckAt: null,
        lastMessage: outcome.message.slice(0, 300),
      };

      if (outcome.status === "settled") {
        result.settled++;
        await logDocumentEvent(env, {
          externalId: c.bookingId,
          event: "settled",
          summary: outcome.message,
          userId: o.userId,
          sourceKind: "lodgify",
          destinationKind: o.destination,
          invoiceId: c.invoiceId,
          actor: o.actor ?? "cron:lodgify-settle",
          detail: { receipt_id: outcome.receiptId, value: outcome.value, collected: c.collected },
          dedupKey: `settle:${c.invoiceId}:${Math.round((outcome.settledTotal ?? 0) * 100)}`,
        });
      } else if (outcome.status === "skipped") {
        result.skipped++;
        // A draft is a deliberate state in this fleet, not a fault: it waits for
        // the merchant. Look again in a few hours instead of every half hour.
        if (outcome.reason === "not_closed") {
          next.nextCheckAt = new Date(nowMs + DRAFT_COOLDOWN_MS).toISOString();
        }
      } else if (outcome.status === "blocked") {
        result.blocked++;
        next.needsHuman = true;
        await reportIncident(env, {
          user_id: o.userId,
          severity: "warning",
          kind: "destination_reject",
          dedup_key: `settle-blocked:${c.invoiceId}`,
          summary: `Recibo não emitido para a reserva ${c.bookingId}: ${outcome.message}`.slice(0, 500),
          detail: { booking_id: c.bookingId, invoice_id: c.invoiceId, reason: outcome.reason, collected: c.collected },
          affected_ids: [c.bookingId],
          connection_label: o.connLabel,
          order_ref: `#${c.bookingId}`,
        });
        await logDocumentEvent(env, {
          externalId: c.bookingId,
          event: "held",
          summary: outcome.message,
          userId: o.userId,
          sourceKind: "lodgify",
          destinationKind: o.destination,
          invoiceId: c.invoiceId,
          actor: o.actor ?? "cron:lodgify-settle",
          detail: { reason: outcome.reason },
          dedupKey: `settle-blocked:${c.invoiceId}`,
        });
      } else if (outcome.status === "error") {
        result.errors++;
        const prior = state.get(`${c.bookingId}:${c.invoiceId}`);
        next.attempts = (prior?.attempts ?? 0) + 1;
        // A receipt Moloni accepted that did not reconcile is the runaway case:
        // the delta stays positive and every later pass issues another one. Park
        // it. Same for an id that resolves nowhere, after a few tries.
        const park = outcome.code === "not_reconciled"
          || outcome.code === "insert_unknown"
          || (outcome.code === "not_found" && next.attempts >= MISSING_MAX_ATTEMPTS);
        next.needsHuman = park;
        await reportIncident(env, {
          user_id: o.userId,
          severity: park ? "critical" : "warning",
          kind: "destination_reject",
          dedup_key: `settle-error:${c.invoiceId}`,
          summary: `Falha ao registar pagamento da reserva ${c.bookingId}: ${outcome.message}`.slice(0, 500),
          detail: { booking_id: c.bookingId, invoice_id: c.invoiceId, code: outcome.code, attempts: next.attempts },
          affected_ids: [c.bookingId],
          connection_label: o.connLabel,
          order_ref: `#${c.bookingId}`,
        });
      }

      await storage.upsertSettlementState(o.userId, next);

      // A misconfigured connection fails identically for every document, so stop
      // after the first rather than raise forty incidents about one missing key.
      if (outcome.status === "error" && outcome.code === "config") break;
    } catch (e: any) {
      result.errors++;
      const msg = String(e?.message ?? e);
      result.rows.push({ ...base, status: "error", message: msg });
      console.error(`[LodgifySettle] ${o.userId} booking ${c.bookingId}: ${msg}`);
      await reportIncident(env, {
        user_id: o.userId,
        severity: "warning",
        kind: "destination_reject",
        dedup_key: `settle-error:${c.invoiceId}`,
        summary: `Falha ao registar pagamento da reserva ${c.bookingId}: ${msg}`.slice(0, 500),
        detail: { booking_id: c.bookingId, invoice_id: c.invoiceId, error: msg },
        affected_ids: [c.bookingId],
        connection_label: o.connLabel,
        order_ref: `#${c.bookingId}`,
      });
    } finally {
      if (!o.dryRun) await storage.releaseSettlementClaim(o.userId, c.invoiceId);
    }
  }

  return result;
}
