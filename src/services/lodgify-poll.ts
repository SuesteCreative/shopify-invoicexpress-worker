// Lodgify booking poller — lifted out of index.ts, where it was a thousand
// lines of polling sitting in the worker entrypoint. Only three symbols ever
// crossed the boundary (pollLodgifyBookings, reportLodgifyRelayDown and
// reportStaleLodgifyIngest, all cron entry points), so the seam was already
// there; it just had no file.

import type { Env } from "../env";
import { AppStorage } from "../storage";
import type { IRequestConfig } from "../storage";
import type { DestinationKind } from "../adapters/types";
import { getSourceAdapter, getDestinationAdapter } from "../adapters/registry";
import {
  GATEWAY_ERROR_HEADER, describeLodgifyEgress, isGatewayFailure, lodgifyFetch,
  resolveLodgifyGateway, type LodgifyGateway,
} from "./lodgify-api";
import {
  firstNum, bookingCollectedAmount, isBookingFullyCollected, collectedSqlPredicate,
  awaitingPaymentMarkSqlPredicate, otaPolicyFrom, otaStayCollectedSqlPredicate, partialModeFrom,
} from "./lodgify-amounts";
import { toPreloadedFromItem } from "./lodgify-booking";
import { applyConnectionEmailPref, projectConnectionBehaviour } from "./connection-context";
import { loadTagRoutingRules, matchTagRouting, normalizeRule, applyTagRoute } from "./tag-routing";
import { loadProductMappings } from "./product-mappings";
import { logDocumentEvent } from "./document-log";
import { saleReference, partialSaleReference } from "./document-references";
import { reportIncident } from "./incidents";
import { checkSubscriptionGate } from "./subscription-gate";
import { runAdapterPipeline, classifyPipelineError } from "../handlers/generic-pipeline";
import { takeBackLodgifyDocuments } from "../handlers/lodgify-billing";
import { settleLodgifyReceipts } from "../handlers/lodgify-settlement";
import { delay } from "../utils";

// ── Lodgify booking poller (cron) ─────────────────────────────────────────────
// Lodgify does not expose webhook registration to user-level API keys (partner
// OAuth only), so new-customer bookings never arrive via /webhooks/lodgify/*.
// This poll lists Booked bookings per active connection and drives the SAME
// pipeline the webhook uses (with a preloaded booking), deduped on the shared
// `lodgify/created` webhook-info key so a booking is invoiced at most once
// regardless of which path sees it first.

// First non-empty trimmed string among vals, or null. Used to pull the guest
// comment (where the NIF is typed) out of whichever field Lodgify carries it in.
// Normalize a v1 `/v1/reservation` item to the v2-shaped fields the poll, the
// invoice gate (bookingAmountDue) and the D1 mirror (upsertLodgifyBookings) were
// written against. The v1 list is the COMPLETE booking set (see
// listLodgifyBookings) but names its payment fields differently; alias them so
// nothing downstream needs to change:
//   amount_to_pay → amount_due   (outstanding balance; ≈0 ⇒ settled, incl. OTA
//                                 stays where Booking.com/Airbnb collected)
//   total_paid    → amount_paid
//   currency{code}→ currency_code (v1 nests currency as an object)
// Every original v1 field is preserved (status, guest.name/email, property_id,
// source, arrival/departure, created_at, rooms) — those already line up.
function normalizeLodgifyV1Item(v1: any): any {
  const cur = v1?.currency;
  const currency_code = typeof cur === "string" ? cur : (cur?.code ?? "EUR");
  return {
    ...v1,
    amount_due: firstNum(v1?.amount_to_pay, v1?.amount_due),
    amount_paid: firstNum(v1?.total_paid, v1?.amount_paid),
    currency_code,
  };
}

// List ALL Lodgify bookings for the account via the v1 `/v1/reservation`
// endpoint (offset/limit paging, exposes a `total`). We use v1 — NOT v2
// `/v2/reservations/bookings` — because the v2 list silently OMITS bookings
// (confirmed live: OTA reservations absent from v2 even with a wide
// updatedSince, which left them off conciliação AND un-invoiced). v1 returns the
// full set; each item is normalized to the v2 shape the rest of the poll reads.
// `trash=False` drops trashed bookings. Retries 429 with Retry-After backoff and
// paces pages; on exhaustion returns what it has rather than throwing (a
// background sync must never crash the whole poll over a transient limit).
async function listLodgifyBookings(apiKey: string, gateway: LodgifyGateway): Promise<any[]> {
  const out: any[] = [];
  const limit = 50;
  for (let page = 0; page < 40; page++) {
    const path = `/v1/reservation?offset=${page * limit}&limit=${limit}&trash=False`;
    let items: any[] | null = null;
    let lastFailure = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await lodgifyFetch(path, { apiKey, gateway });
      if (res.ok) {
        const raw = await res.text();
        let data: any = null;
        try { data = JSON.parse(raw); } catch { /* handled below */ }
        if (data == null) {
          // A 200 whose body isn't JSON is a bot/WAF challenge or an outage
          // page, NOT "this account has no bookings". Treating it as an empty
          // list is how a dead poll looks identical to an idle one.
          lastFailure = `200 with unparseable body: ${raw.slice(0, 120)}`;
          break;
        }
        items = Array.isArray(data?.items) ? data.items
          : Array.isArray(data) ? data
          : [];
        break;
      }
      lastFailure = `${res.status} ${res.statusText}`;
      // The RELAY failed, not Lodgify. Not a rate limit, will not heal by
      // backing off, and must not be read as an IP block — the remedy is our
      // box, not Lodgify. Name it so the incident says which.
      if (isGatewayFailure(res)) {
        throw new Error(
          `LODGIFY_RELAY_DOWN: ${describeLodgifyEgress(gateway)} → ${res.status} `
          + `(${res.headers.get(GATEWAY_ERROR_HEADER)})`,
        );
      }
      if (res.status === 429) {
        // Lodgify returns 429 for BOTH a transient rate limit and a permanent IP
        // block ("flagged as an unregistered API user requesting data for
        // multiple Lodgify end users"). Retrying the latter is pointless and it
        // needs a completely different response from us, so separate them here.
        // Which response depends on the egress: from a rotating Cloudflare
        // address the remedy is the relay; from the ALLOWLISTED relay IP it
        // means the allowlist itself was revoked — stop polling and talk to
        // Lodgify. `relayed` is carried into the message for exactly that.
        const blockBody = await res.text().catch(() => "");
        if (/unregistered API user|lodgify\.com\/partners|has been blocked/i.test(blockBody)) {
          throw new Error(
            `LODGIFY_IP_BLOCKED via ${describeLodgifyEgress(gateway)}: ${blockBody.slice(0, 300)}`,
          );
        }
        const ra = Number(res.headers.get("retry-after"));
        await delay(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 6000) : 700 * (attempt + 1));
        continue;
      }
      console.error(`[LodgifyPoll] v1 list ${res.status} ${res.statusText}`);
      break;
    }
    // Never return a short list as if it were the truth. Page 0 failing means we
    // know nothing about this account — throw so the caller reports an incident
    // instead of silently "finding no bookings" (the failure mode that let the
    // poll look healthy while fetching nothing at all). A later page failing
    // would silently truncate the set, which the invoice loop would read as
    // "these bookings no longer exist", so treat it the same way.
    if (items == null) {
      throw new Error(`Lodgify v1 list failed at offset ${page * limit}: ${lastFailure || "no response"}`);
    }
    for (const it of items) out.push(normalizeLodgifyV1Item(it));
    if (items.length < limit) break;
    await delay(250); // pace pages to avoid re-tripping the rate limit
  }
  return out;
}

// Emit one instalment (partial) invoice for a booking via the destination
// adapter, billing only `deltaAmount` under a distinct reference "Order #N-seq"
// and a "parcela" note. Respects tag-routing (series/doc-type) the same way the
// standard pipeline does. Idempotent: dedups on the reference at the destination
// so a crash between create and record doesn't duplicate.
async function emitLodgifyPartialInvoice(env: Env, o: {
  config: any;
  sourceCfg: Record<string, any>;
  destinationConfig: Record<string, any> | undefined;
  destination: any;
  productMappings: Map<string, number> | undefined;
  tagRoutingRules: import("./tag-routing").TagRoutingRule[];
  bookingItem: any;
  bookingId: string;
  seq: number;
  deltaAmount: number;
  totalAmount: number;
}): Promise<string> {
  const orderNum = Number(String(o.bookingId).replace(/\D/g, "").slice(-12)) || 0;
  const reference = partialSaleReference(orderNum, o.seq);
  const pct = o.totalAmount > 0 ? Math.round((o.deltaAmount / o.totalAmount) * 100) : 0;
  const note = o.seq > 1
    ? `Parcela ${o.seq} — ${pct}% da reserva LOD-${o.bookingId} (ref. ${saleReference(orderNum)}; 1ª parcela: ${partialSaleReference(orderNum, 1)})`
    : `Parcela ${o.seq} — ${pct}% da reserva LOD-${o.bookingId} (ref. ${saleReference(orderNum)})`;

  const sourceAdapter = getSourceAdapter("lodgify");
  const destAdapter = getDestinationAdapter(o.destination);

  let ctx: any = {
    apiKey: env.NORMALIZE_SHOPIFY_ORDER_API_KEY,
    config: o.config,
    sourceConfig: o.sourceCfg,
    destinationConfig: o.destinationConfig,
    productMappings: o.productMappings,
  };

  // Normalize the v2 item to the shape LodgifySource reads (maps total_amount →
  // total, rooms[].room_type_id, keeps property_id/source for tag-routing). The
  // _partial.amount then overrides the gross with this instalment's delta.
  // `data.bookingId` is REQUIRED: LodgifySource.externalId() reads booking.id /
  // data.bookingId / bookingId and throws without one. Omitting it made every
  // progressive invoice throw "Lodgify webhook missing booking.id /
  // data.bookingId" before it reached the destination — the standard path has
  // always sent it, this path never did, and the swallowed catch meant
  // progressive invoicing failed 100% of the time in silence.
  const body = {
    event: "booking_new_status_booked",
    data: { bookingId: o.bookingId },
    _preloaded_booking: toPreloadedFromItem(o.bookingItem),
    _partial: { seq: o.seq, amount: o.deltaAmount, reference, note },
  };
  const normalized = await sourceAdapter.toNormalized(body, ctx);
  if (!normalized) throw new Error(`[LodgifyPoll] partial normalize failed for ${o.bookingId} seq ${o.seq}`);

  // Tag routing — route this instalment to the property's series / doc type.
  // Shares applyTagRoute with generic-pipeline.ts; this used to be a private
  // copy that only handled Moloni and only understood the `_draft` suffix.
  const tagMatch = matchTagRouting(normalized.order, o.tagRoutingRules);
  if (tagMatch) ctx = applyTagRoute(ctx, o.destination, normalizeRule(tagMatch));

  // Idempotency: if this instalment's reference already exists at the
  // destination (crash after create, before we recorded it), reuse it.
  if (destAdapter.findByReference) {
    const found = await destAdapter.findByReference(reference, ctx);
    if (found) return found.id;
  }

  const { invoiceId } = await destAdapter.createDraft(normalized, ctx);
  await logDocumentEvent(env, {
    externalId: String(o.bookingId),
    event: "built",
    dedupKey: `built:${invoiceId}`,
    invoiceId,
    userId: o.config?.user_id ?? null,
    shopifyDomain: null,
    sourceKind: "lodgify",
    destinationKind: String(o.destination),
    actor: "cron:lodgify-poll",
    summary: `Documento ${invoiceId} emitido por ${o.deltaAmount.toFixed(2)} € — parcela ${o.seq} da reserva LOD-${o.bookingId}, referência ${reference}.`,
    detail: {
      intent: {
        total: Number.isFinite(o.deltaAmount) ? o.deltaAmount : null,
        reference,
        exemptionCode: null,
      },
      seq: o.seq,
    },
  });
  if (ctx.config?.auto_finalize === 1) {
    try {
      await destAdapter.finalize(invoiceId, ctx);
      await logDocumentEvent(env, {
        externalId: String(o.bookingId),
        event: "finalized",
        dedupKey: `finalized:${invoiceId}`,
        invoiceId,
        userId: o.config?.user_id ?? null,
        shopifyDomain: null,
        sourceKind: "lodgify",
        destinationKind: String(o.destination),
        actor: "cron:lodgify-poll",
        summary: `Documento ${invoiceId} (parcela ${o.seq} da reserva LOD-${o.bookingId}) fechado no destino.`,
      });
    } catch (e: any) {
      // The document EXISTS and is recorded — rethrowing here would make the
      // caller believe the instalment was never billed and bill it again on the
      // next poll. So the create stands and the finalize failure is escalated
      // instead of being a console line nobody reads: the merchant is left with
      // a draft that will never certify itself, which is exactly the shape of
      // failure this integration keeps being bitten by.
      const detail = String(e?.message ?? e).slice(0, 400);
      console.error(`[LodgifyPoll] finalize partial ${reference} failed: ${detail}`);
      await reportIncident(env, {
        user_id: o.config?.user_id ?? null,
        severity: "error",
        kind: "destination_reject",
        dedup_key: String(invoiceId),
        summary: `A prestação ${reference} da reserva ${o.bookingId} foi emitida (documento ${invoiceId}) mas ficou por fechar: ${detail}`,
        detail: { booking_id: o.bookingId, seq: o.seq, reference, invoiceId, error: detail },
        affected_ids: [String(o.bookingId)],
        connection_label: `lodgify → ${o.destination}`,
        order_ref: `#${o.bookingId}`,
        bucket: "daily",
      });
    }
  }
  return invoiceId;
}

/**
 * Take back the documents issued for a booking that has since been cancelled.
 *
 * The merchant's objection, in their words: "até lá podem ainda ser canceladas e
 * depois já temos as faturas emitidas." Waiting for the payment to be recorded
 * (see `bookingCollectedAmount`) makes this rare, but not impossible — a guest
 * can still cancel a stay that was already paid and billed, and the fleet has
 * older documents issued under the previous rule.
 *
 * Drafts are deleted outright: nothing fiscal has happened to them, so removing
 * one is a clean undo. A FINALIZED document is never touched — it is AT-hashed
 * and only a credit note can undo it, which is a decision with a human on the
 * other end of it, so that raises an incident instead.
 *
 * Returns true when something was actually reversed.
 */
async function reverseCancelledLodgifyBooking(env: Env, o: {
  userId: string;
  bookingId: string;
  connLabel: string;
  destination: DestinationKind;
  config: any;
  sourceCfg: Record<string, any>;
  destinationConfig: Record<string, any> | undefined;
}): Promise<boolean> {
  const r = await takeBackLodgifyDocuments(env, { ...o, dryRun: false });
  if (r.invoiceIds.length === 0) return false;

  if (r.finalized.length > 0) {
    await reportIncident(env, {
      user_id: o.userId,
      severity: "error",
      kind: "booking_cancelled_after_invoice",
      summary: `Reserva ${o.bookingId} foi cancelada mas ${r.finalized.length} documento(s) já estão finalizados — é preciso emitir nota de crédito manualmente.`,
      detail: { booking_id: o.bookingId, finalized: r.finalized, deleted: r.deleted },
      affected_ids: [o.bookingId],
      connection_label: o.connLabel,
      order_ref: `#${o.bookingId}`,
      // The poll runs every 30 min and a finalized document stays finalized, so
      // this condition re-fires forever until a human issues the credit note.
      // Daily bucket = one reminder a day, not 48.
      bucket: "daily",
    });
  } else {
    console.log(`[LodgifyPoll] booking ${o.bookingId} cancelled — removed ${r.deleted.length} draft(s)`);
  }
  return true;
}


interface LodgifyPollResult {
  connections: number; scanned: number; invoiced: number; skipped: number; failed: number; synced: number;
  /** Documents taken back because their booking was cancelled after we billed it. */
  reversed: number;
  /** Payments recorded against already-certified documents (Moloni Recibos). */
  settled: number;
  /** Documents a guard refused and parked for a human. Silence here is the point. */
  settleBlocked: number;
  settleErrors: number;
  /**
   * Dry-run only: the bookings this run WOULD have billed, in the order it would
   * have billed them. Exists so a caller outside the Worker (the Lodgify feeder,
   * which fetches the list from a non-blocked network) can learn which handful of
   * bookings is worth enriching with a per-booking detail call — without
   * reimplementing a single settlement rule on its side.
   */
  wouldInvoice?: Array<{ booking_id: string; path: "standard" | "partial"; seq?: number; amount: number }>;
}

/**
 * Has this connection ever actually issued an invoice?
 *
 * Distinguishes two states the gate treats identically: a merchant who was
 * invoicing and went dark (a regression — alert), versus one who has never
 * issued anything and is simply awaiting activation under pay-to-activate
 * (expected — alerting daily on it is pure noise). Pre-existing external markers
 * in lodgify_partial_invoices carry invoice_id NULL and don't count.
 *
 * Errs toward `true` on failure: the point of this whole path is to stop being
 * silent, so an unknown state should alert rather than swallow.
 */
async function hasEverInvoiced(env: Env, userId: string): Promise<boolean> {
  try {
    const processed: any = await env.DB.prepare(
      "SELECT 1 AS hit FROM processed_orders WHERE user_id = ? LIMIT 1"
    ).bind(userId).first();
    if (processed?.hit) return true;
    const partial: any = await env.DB.prepare(
      "SELECT 1 AS hit FROM lodgify_partial_invoices WHERE user_id = ? AND invoice_id IS NOT NULL LIMIT 1"
    ).bind(userId).first();
    return !!partial?.hit;
  } catch {
    return true;
  }
}

export interface LodgifyPollOptions {
  /** Restrict the run to one connection. */
  userId?: string;
  /**
   * RAW v1 `/v1/reservation` items, used INSTEAD of fetching from Lodgify.
   * Requires userId. Recovery lever for when Lodgify rate-limits the Worker's
   * egress (it 429s Cloudflare's shared IPs while the same key succeeds from
   * elsewhere) — the caller fetches the list from a working network and the
   * worker still runs the real normalization, cutoff, dedup and invoice logic,
   * so nothing fiscal is reimplemented outside this code path.
   */
  bookings?: any[];
  /**
   * Sync and decide, but issue nothing: the mirror is still refreshed (that half
   * is safe and is the whole point of a sync), every gate still runs, and the
   * bookings that would have been billed come back in `wouldInvoice` instead of
   * becoming documents. Cancellation reversal is skipped too — it DELETES
   * documents, which is not a dry run by any reading.
   */
  dryRun?: boolean;
}

export async function pollLodgifyBookings(env: Env, opts: LodgifyPollOptions = {}): Promise<LodgifyPollResult> {
  const result: LodgifyPollResult = {
    connections: 0, scanned: 0, invoiced: 0, skipped: 0, failed: 0, synced: 0, reversed: 0,
    settled: 0, settleBlocked: 0, settleErrors: 0,
  };
  const dryRun = !!opts.dryRun;
  if (dryRun) result.wouldInvoice = [];

  // Resolved once: every connection in this run leaves by the same door, and a
  // missing gateway config should stop the run here rather than have each
  // connection decide for itself. Throws when the egress is misconfigured —
  // deliberately, see resolveLodgifyGateway.
  const gateway = resolveLodgifyGateway(env);
  const egress = describeLodgifyEgress(gateway);

  const baseSql =
    `SELECT id, user_id, source_config_json, destination_kind, destination_config_json, invoice_cutoff
     FROM connections WHERE source_kind = 'lodgify' AND status = 'active'`;
  const conns = opts.userId
    ? await env.DB.prepare(`${baseSql} AND user_id = ?`).bind(opts.userId).all()
    : await env.DB.prepare(baseSql).all();
  const rows = (conns?.results ?? []) as any[];

  for (const conn of rows) {
    result.connections++;

    let sourceCfg: Record<string, any> = {};
    try { sourceCfg = conn.source_config_json ? JSON.parse(conn.source_config_json) : {}; } catch { /* ignore */ }
    // Connection-level failures below use a DAILY bucket: the poll runs every
    // 30 min, so an hourly bucket would email 24×/day for one dead connection.
    // Daily = one alert per day until it's fixed.
    const connLabel = `lodgify → ${conn.destination_kind ?? "moloni"}`;

    const apiKey = sourceCfg.api_key;
    if (!apiKey) {
      console.warn(`[LodgifyPoll] user ${conn.user_id}: no api_key in source_config — skipping`);
      await reportIncident(env, {
        user_id: conn.user_id,
        severity: "critical",
        kind: "auth_failure_source",
        summary: "Ligação Lodgify sem chave de API — nenhuma reserva pode ser facturada.",
        connection_label: connLabel,
        bucket: "daily",
      });
      continue;
    }

    let destinationConfig: Record<string, any> | undefined;
    try { destinationConfig = conn.destination_config_json ? JSON.parse(conn.destination_config_json) : undefined; } catch { destinationConfig = undefined; }

    // Don't invoice bookings created before the connection's cutoff (the
    // subscription start date, stamped when the account activates by payment).
    // NULL cutoff = invoice everything (existing behaviour).
    const cutoffMs = conn.invoice_cutoff ? Date.parse(String(conn.invoice_cutoff)) : null;

    // Same synthesized legacy config + subscription gate the webhook route uses.
    const legacy: any = (await env.DB.prepare("SELECT * FROM integrations WHERE user_id = ?").bind(conn.user_id).first()) ?? {
      user_id: conn.user_id,
      shopify_domain: null,
      auto_finalize: destinationConfig?.auto_finalize ? 1 : 0,
      b2b_reverse_charge: 0,
      ix_send_email: 0,
    };
    applyConnectionEmailPref(legacy, destinationConfig);
    const gate = await checkSubscriptionGate(env, legacy, { source: "lodgify", destination: conn.destination_kind ?? "moloni" });
    if (!gate.allowed) {
      console.warn(`[LodgifyPoll] user ${conn.user_id}: subscription gate blocked (${gate.reason}) — skipping`);
      // Previously console-only: a merchant that WAS invoicing and goes dark
      // because its subscription lapsed did so in total silence. Alert on that.
      // A connection that never issued anything is awaiting activation
      // (pay-to-activate) — an expected state, not an incident.
      if (await hasEverInvoiced(env, conn.user_id)) {
        await reportIncident(env, {
          user_id: conn.user_id,
          severity: "critical",
          kind: "subscription_inactive",
          summary: `Subscrição inactiva (${gate.reason}). Reservas Lodgify deixaram de ser facturadas.`,
          connection_label: connLabel,
          bucket: "daily",
        });
      }
      continue;
    }

    // Full-list sync from Lodgify v1 (`/v1/reservation`). v1 has no reliable
    // updated-since filter (its `updated_at` is frequently unset), and the list
    // is small enough (a few offset pages) to pull whole each poll — the upsert
    // is idempotent and the invoice loop dedups, so re-seeing a booking is cheap.
    // Pulling the full v1 set is what makes EVERY booking reach the mirror /
    // conciliação; the old v2 list silently dropped some.
    let bookings: any[];
    if (opts.bookings && opts.userId === conn.user_id) {
      // Caller supplied the raw v1 list; normalize it exactly as the fetch path
      // does so every downstream rule behaves identically.
      bookings = opts.bookings.map(normalizeLodgifyV1Item);
      console.log(`[LodgifyPoll] user ${conn.user_id}: using ${bookings.length} caller-supplied booking(s)`);
    } else try {
      bookings = await listLodgifyBookings(apiKey, gateway);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      console.error(`[LodgifyPoll] user ${conn.user_id}: list failed: ${msg}`);
      await reportLodgifyFetchFailure(env, {
        userId: conn.user_id, connLabel, message: msg, egress, relayed: gateway.relayed,
      });
      continue;
    }

    // Mirror every fetched booking into D1 so the conciliação view reads locally
    // (no Lodgify call on page load → no 429). Best-effort: a sync failure must
    // not stop invoicing.
    try {
      const synced = await new AppStorage(env, null, conn.user_id).upsertLodgifyBookings(conn.user_id, bookings);
      result.synced += synced;
    } catch (e: any) {
      console.error(`[LodgifyPoll] user ${conn.user_id}: booking sync failed: ${e?.message ?? e}`);
    }

    const storageTopic = "lodgify/created";
    const destination = (conn.destination_kind as any) ?? "moloni";

    // Progressive (instalment) invoicing — opt-in per connection. When on, a
    // booking is invoiced for each newly-paid amount (e.g. 50% deposit, then
    // 50% balance) under distinct references, instead of once at 100% paid.
    // Read through `partialModeFrom` rather than the raw boolean so the poll and
    // the admin paths cannot disagree about which mode a connection is on — and
    // so a connection moved to `invoice_plus_receipts` stops instalment-billing
    // even if the old boolean is still sitting in its config.
    const partialMode = partialModeFrom(destinationConfig);
    const partialEnabled = partialMode === "instalment_invoices" && destination === "moloni";
    // Bookings already billed as instalments, for a connection that has since
    // moved to `invoice_plus_receipts`.
    //
    // They must STAY on the instalment path. The instalment ledger lives in
    // `lodgify_partial_invoices` and is invisible to the standard path's dedup
    // (which reads processed_orders and the webhook marker), so letting them
    // fall through would issue a second document for the WHOLE total of a stay
    // that already has documents for part of it — 23 bookings and 23.160,01 €
    // of them on the one connection this applies to. Skipping them instead
    // would be the opposite fault: the next instalment would never be billed.
    const legacyInstalmentBookings = partialMode === "invoice_plus_receipts" && destination === "moloni"
      ? await new AppStorage(env, null, conn.user_id).listBookingIdsWithPartials(conn.user_id)
      : new Set<string>();
    // Opt-in per connection: bill an OTA stay once it has happened, for hosts
    // whose channel money never reaches Lodgify and who therefore have nothing
    // to mark as paid. Deliberately not applied to the progressive path — that
    // one bills recorded amounts, and there are none to instal.
    const otaPolicy = otaPolicyFrom(destinationConfig);
    const partialCtx = partialEnabled || legacyInstalmentBookings.size > 0
      ? {
          productMappings: await loadProductMappings(env, conn.user_id, "lodgify").catch(() => undefined),
          tagRoutingRules: await loadTagRoutingRules(env, conn.user_id, "lodgify", destination).catch(() => []),
        }
      : null;

    for (const item of bookings) {
      const status = String(item?.status ?? "").toLowerCase();
      const bookingId = String(item?.id ?? item?.booking_id ?? item?.reservation_id ?? "");
      if (!bookingId) continue;

      // A booking that stopped being "Booked" after we billed it must have that
      // document taken back. The declined → credit-note branch lives on the
      // Lodgify webhook, which never fires here (user API keys cannot register
      // webhooks — partner OAuth only), so before this the poll simply skipped
      // cancelled bookings and left their documents standing forever.
      if (status !== "booked") {
        // Reversal deletes drafts and clears markers — never on a dry run.
        if (!dryRun && (status === "declined" || status === "cancelled" || status === "canceled")) {
          const reversed = await reverseCancelledLodgifyBooking(env, {
            userId: conn.user_id, bookingId, connLabel, destination,
            config: legacy, sourceCfg, destinationConfig,
          });
          if (reversed) result.reversed++;
        }
        continue;
      }
      result.scanned++;
      const appStorage = new AppStorage(env, null, conn.user_id);

      // Retroactive-invoicing guard: never invoice bookings created before the
      // connection's cutoff (the subscription start date). The mirror already
      // stored them for reconciliação; we simply don't bill pre-subscription
      // history. Covers both the progressive and standard paths below.
      if (cutoffMs != null && Number.isFinite(cutoffMs)) {
        const createdMs = Date.parse(String(item?.created_at ?? ""));
        if (Number.isFinite(createdMs) && createdMs < cutoffMs) { result.skipped++; continue; }
      }

      // ── Progressive path: bill each newly-paid delta ──────────────────────
      // Either the connection is on instalments, or it has moved off them and
      // this booking is one of the ones left mid-ledger (see above).
      const useProgressive = partialEnabled || legacyInstalmentBookings.has(bookingId);
      if (useProgressive && partialCtx) {
        const total = Number(item?.total_amount ?? 0);
        // Money recorded in Lodgify is the only trigger. For OTA stays the
        // merchant marks the booking paid by hand once the channel pays out;
        // until then there is nothing to bill. Reading amount_due==0 as "paid"
        // is what billed a fleet of future reservations.
        const { collected: paid, basis } = bookingCollectedAmount(item);
        if (paid <= 0.01) {
          console.log(`[LodgifyPoll] booking ${bookingId} held (${basis})`);
          result.skipped++; continue;
        }
        const partials = await appStorage.getPartialInvoices(conn.user_id, bookingId);
        // Transition guard: a booking already invoiced by the STANDARD flow
        // lives under processed_orders / "Order #N" — the instalment dedup
        // ("Order #N-seq") wouldn't see it, so billing it progressively would
        // DUPLICATE. Leave those to the old flow; only bookings with no prior
        // standard invoice (or already mid-instalment) go progressive.
        if (partials.length === 0) {
          const standard = await appStorage.getInvoiceByOrderId(bookingId);
          if (standard?.invoice_id) { result.skipped++; continue; }
        }
        const already = partials.reduce((s, p) => s + p.invoiced_amount, 0);
        const delta = Math.round((paid - already) * 100) / 100;
        if (delta <= 0.01) { result.skipped++; continue; }             // no new payment to bill
        const seq = partials.length + 1;
        if (dryRun) {
          result.wouldInvoice!.push({ booking_id: bookingId, path: "partial", seq, amount: delta });
          continue;
        }
        try {
          const invoiceId = await emitLodgifyPartialInvoice(env, {
            config: legacy, sourceCfg, destinationConfig, destination,
            productMappings: partialCtx.productMappings, tagRoutingRules: partialCtx.tagRoutingRules,
            bookingItem: item, bookingId, seq, deltaAmount: delta, totalAmount: total,
          });
          const orderNum = Number(String(bookingId).replace(/\D/g, "").slice(-12)) || 0;
          await appStorage.upsertPartialInvoice(conn.user_id, bookingId, seq, invoiceId, delta, partialSaleReference(orderNum, seq));
          result.invoiced++;
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          console.error(`[LodgifyPoll] user ${conn.user_id}: partial invoice failed for ${bookingId} seq ${seq}: ${msg}`);
          // The progressive path calls emitLodgifyPartialInvoice directly rather
          // than runAdapterPipeline, so it never inherited the pipeline's incident
          // reporting — every failure here was swallowed into a counter. Report it
          // the same way the standard path does.
          const { kind, severity } = classifyPipelineError(e);
          await reportIncident(env, {
            user_id: conn.user_id,
            severity,
            kind,
            summary: `Factura progressiva falhou para a reserva ${bookingId} (prestação ${seq}): ${msg}`.slice(0, 500),
            detail: { booking_id: bookingId, seq, delta, error: msg },
            affected_ids: [bookingId],
            connection_label: connLabel,
            order_ref: `#${bookingId}`,
          });
          result.failed++;
        }
        continue;
      }

      // ── Standard path: one document for the whole total, so it may only fire
      // once the WHOLE total is collected. Same settlement rule as the
      // progressive path above — the two must never disagree about whether a
      // booking has been paid for, only about how many documents that produces.
      // `otaPolicy` (opt-in per connection) additionally accepts an OTA stay
      // that has already happened: the channel collected the money and it never
      // passes through Lodgify, so there is no payment for the merchant to
      // record. Off everywhere it is not configured.
      // `invoice_plus_receipts` is the exception, and only for a stay with money
      // already recorded against it: the whole stay is invoiced as a Fatura (a
      // debt, not a payment) and each payment is then receipted against it by
      // /admin/lodgify/settle-receipts. Holding it here would leave the merchant
      // with a deposit in the bank and nothing issued for the stay.
      const pollSettlement = bookingCollectedAmount(item);
      const receiptsModeBillable = partialMode === "invoice_plus_receipts"
        && pollSettlement.basis === "instalment";
      if (!receiptsModeBillable && !isBookingFullyCollected(item, otaPolicy)) {
        console.log(`[LodgifyPoll] booking ${bookingId} held (${pollSettlement.basis})`);
        result.skipped++; continue;
      }

      // Shared dedup with the webhook path — invoice a booking at most once.
      const { isProcessed, state } = await appStorage.isWebhookProcessed(bookingId, storageTopic);
      if (isProcessed && state !== "failed") { result.skipped++; continue; }

      // Defensive dedup: the v1 list surfaces bookings the old v2 list omitted —
      // some already invoiced out-of-band (a manual admin re-emit, or a run whose
      // webhook_info write was lost). If an invoice is already mapped for this
      // booking, don't create a second one; heal the processed marker instead.
      const existingInvoice = await appStorage.getInvoiceByOrderId(bookingId);
      if (existingInvoice?.invoice_id) {
        await appStorage.markWebhookAsProcessed(bookingId, storageTopic, "success");
        result.skipped++; continue;
      }

      if (dryRun) {
        result.wouldInvoice!.push({ booking_id: bookingId, path: "standard", amount: Number(item?.total_amount ?? 0) });
        continue;
      }

      await appStorage.markWebhookAsProcessing(bookingId, storageTopic);
      const body = { event: "booking_new_status_booked", data: { bookingId }, _preloaded_booking: toPreloadedFromItem(item) };
      try {
        await runAdapterPipeline({
          env,
          config: legacy,
          source: "lodgify",
          destination,
          topic: "created" as any,
          webhookId: bookingId,
          body,
          sourceConfig: sourceCfg,
          destinationConfig,
        });
        await appStorage.markWebhookAsProcessed(bookingId, storageTopic, "success");
        result.invoiced++;
      } catch (e: any) {
        console.error(`[LodgifyPoll] user ${conn.user_id}: pipeline failed for booking ${bookingId}: ${e?.message ?? e}`);
        await appStorage.markWebhookAsProcessed(bookingId, storageTopic, "failed");
        result.failed++;
      }
    }

    // Record the money on documents that are already certified.
    //
    // Here, and not on a cron of its own, because this pass needs exactly what
    // the loop above just fetched: how much Lodgify says has come in, and
    // whether the stay is still Booked. Reading that back from the mirror would
    // work on a good day and settle a cancelled booking on a bad one — and if
    // the Lodgify list failed, this connection already `continue`d long before
    // here, so there is no version of this that runs on stale numbers.
    //
    // After the billing loop, wrapped, and capped: a settlement failure must
    // never cost an invoice, and whatever is deferred is picked up in 30 minutes.
    if (!dryRun && destination === "moloni" && partialMode === "invoice_plus_receipts"
        && env.LODGIFY_SETTLE_AUTO === "1") {
      try {
        const settle = await settleLodgifyReceipts(env, {
          userId: conn.user_id,
          destination,
          config: projectConnectionBehaviour(legacy, destinationConfig, "lodgify"),
          sourceCfg,
          destinationConfig,
          connLabel,
          items: bookings,
          dryRun: false,
          limit: Number.isFinite(Number(env.LODGIFY_SETTLE_MAX_DOCS))
            && String(env.LODGIFY_SETTLE_MAX_DOCS ?? "").trim() !== ""
            ? Number(env.LODGIFY_SETTLE_MAX_DOCS)
            : undefined,
          actor: "cron:lodgify-poll",
        });
        result.settled += settle.settled;
        result.settleBlocked += settle.blocked;
        result.settleErrors += settle.errors;
        if (settle.settled > 0 || settle.errors > 0 || settle.blocked > 0) {
          console.log(`[LodgifyPoll] user ${conn.user_id}: settled ${settle.settled}, blocked ${settle.blocked}, errors ${settle.errors}`);
        }
      } catch (e: any) {
        result.settleErrors++;
        console.error(`[LodgifyPoll] user ${conn.user_id}: settlement pass failed: ${String(e?.message ?? e)}`);
      }
    }

    // Backlog check — runs after the mirror is fresh for this connection.
    await reportLodgifyBacklog(env, conn.user_id, conn.invoice_cutoff, connLabel, otaPolicy);

    // Record that ingestion actually completed for this connection. Deliberately
    // NOT on dry runs: the feeder's cycle is dry-then-real, so marking the dry
    // half would keep the light green while every real run failed.
    if (!dryRun) await markLodgifyIngest(env, conn.user_id);
  }

  return result;
}

/**
 * Report a failure to obtain the booking list from Lodgify.
 *
 * One path now: this Worker's own fetch, through the egress relay. The external
 * feeder that used to share this (and the two admin routes that served it, one
 * of which handed out every merchant's plaintext API key) is gone — a second,
 * unallowlisted IP pulling several end users' bookings is the exact behaviour
 * Lodgify's block text names, so it could not survive the relay.
 */
async function reportLodgifyFetchFailure(
  env: Env,
  o: { userId: string; connLabel: string; message: string; egress?: string; relayed?: boolean },
): Promise<void> {
  // A rejected key is permanent until re-authed; anything else is likely a
  // transient Lodgify outage that the next poll clears. Both used to be
  // console-only, so a revoked key looked identical to "nothing to do".
  const isRelayDown = o.message.includes("LODGIFY_RELAY_DOWN");
  const isBlocked = o.message.includes("LODGIFY_IP_BLOCKED")
    || /unregistered API user|lodgify\.com\/partners|has been blocked/i.test(o.message);
  const isAuth = /\b(401|403)\b|unauthorized|forbidden|invalid api key/i.test(o.message);

  // An alert that names the wrong action is worse than no alert. A block on a
  // rotating Cloudflare address and a block on the ALLOWLISTED relay IP look
  // identical in the response body and have opposite remedies, so branch on
  // which egress actually made the call.
  const blockedSummary = o.relayed
    ? `Lodgify bloqueou o IP FIXO do relay (${o.egress ?? "relay"}). O allowlist foi revogado: PARAR o polling e falar com o suporte da Lodgify. NÃO trocar de IP.`
    : "Lodgify BLOQUEOU o IP do servidor: integrador não registado como parceiro. Nenhuma reserva pode ser sincronizada até registar em lodgify.com/partners.";

  await reportIncident(env, {
    user_id: o.userId,
    severity: isRelayDown || isBlocked || isAuth ? "critical" : "error",
    // A dead relay is ours to fix, not a credentials problem and not Lodgify's.
    kind: isRelayDown ? "lodgify_relay_down" : "auth_failure_source",
    summary: isRelayDown
      ? `O relay de saída da Lodgify não respondeu (${o.egress ?? "relay"}). Nenhuma reserva pode ser sincronizada enquanto estiver em baixo.`
      : isBlocked
        ? blockedSummary
        : isAuth
          ? "Lodgify rejeitou a chave de API — reservas não estão a ser sincronizadas nem facturadas."
          : `Não foi possível obter reservas do Lodgify: ${o.message}`.slice(0, 500),
    detail: { error: o.message, egress: o.egress ?? null },
    connection_label: o.connLabel,
    // An outage gets the default hourly bucket: a daily one would sit on it for
    // the rest of the day. Everything else stays daily, as before.
    ...(isRelayDown ? {} : { bucket: "daily" as const }),
  });
}

/**
 * The relay is down (or unconfigured), so no connection can be polled at all.
 *
 * One ops incident for the platform rather than one per merchant: the cause is
 * shared, and N identical criticals would bury it. Hourly bucket — this is an
 * outage, and the 08:00 stale-ingestion check is six hours too late to be the
 * first thing that notices.
 */
export async function reportLodgifyRelayDown(
  env: Env,
  probe: { base: string; status?: number; error?: string },
): Promise<void> {
  const detail = probe.error ?? `HTTP ${probe.status ?? "?"}`;
  await reportIncident(env, {
    severity: "critical",
    kind: "lodgify_relay_down",
    summary: `O relay de saída da Lodgify não responde (${probe.base}): ${detail}. `
      + `Nenhuma reserva é sincronizada nem facturada até voltar. `
      + `Rollback: LODGIFY_EGRESS_MODE="direct" (volta ao estado bloqueado, sem falha nova).`,
    detail: { base: probe.base, status: probe.status ?? null, error: probe.error ?? null },
    connection_label: "lodgify → (todas)",
  });
}

/** sweep_state key under which a connection's last completed ingestion is stamped. */
function lodgifyIngestKey(userId: string): string {
  return `lodgify-ingest:${userId}`;
}

/**
 * Stamp "ingestion completed" for a Lodgify connection.
 *
 * Reuses `sweep_state` — a table that already answers exactly this question
 * ("when did this periodic job last finish for this subject") — under a
 * namespaced key, rather than adding a table and a hand-applied migration for
 * one timestamp. The column is named `shopify_domain` for historical reasons;
 * it is a plain TEXT primary key.
 *
 * Why a marker and not `MAX(lodgify_bookings.synced_at)`: a dormant merchant
 * (no bookings at all, or paused for the season) upserts no rows, so mirror
 * freshness would page every day about a connection that is perfectly healthy.
 * A completed run is the thing worth watching, and it is independent of whether
 * the merchant sold anything.
 */
async function markLodgifyIngest(env: Env, userId: string): Promise<void> {
  const nowIso = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO sweep_state (shopify_domain, last_started_at, last_completed_at, last_status, last_detail_json)
       VALUES (?1, ?2, ?2, 'ok', NULL)
       ON CONFLICT(shopify_domain) DO UPDATE SET
         last_started_at   = excluded.last_started_at,
         last_completed_at = excluded.last_completed_at,
         last_status       = excluded.last_status`
    ).bind(lodgifyIngestKey(userId), nowIso).run();
  } catch (e: any) {
    // Never let bookkeeping break a poll that already did its real work.
    console.warn(`[LodgifyPoll] ingest marker failed for ${userId}: ${e?.message ?? e}`);
  }
}

/**
 * Alert when settled bookings are piling up uninvoiced.
 *
 * The failure this catches: every per-poll counter can look healthy while
 * nothing is actually being billed. Overbuilding sat at 269 bookings / 0
 * invoices for 26 days and no metric noticed, because "skipped" is the normal
 * outcome for most bookings on most polls. This asks the only question that
 * matters — are there settled, post-cutoff bookings with no invoice? — straight
 * against the D1 mirror, so it is immune to whichever code path is broken.
 *
 * 48h grace keeps brand-new bookings (payment still settling, OTA sync lag) out
 * of the count. Daily bucket: one alert per day while a backlog persists.
 */
async function reportLodgifyBacklog(
  env: Env,
  userId: string,
  invoiceCutoff: string | null,
  connLabel: string,
  otaPolicy?: ReturnType<typeof otaPolicyFrom>,
): Promise<void> {
  const graceIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const otaSql = otaStayCollectedSqlPredicate(otaPolicy);
  const notBilled =
    `AND NOT EXISTS (SELECT 1 FROM lodgify_partial_invoices p WHERE p.booking_id = b.id)
     AND NOT EXISTS (SELECT 1 FROM processed_orders o WHERE o.id = b.id AND o.invoice_id IS NOT NULL)`;
  try {
    // (1) Money recorded in Lodgify that we never turned into a document. Same
    // rule as the invoice gate, expressed against the mirror. This used to read
    // `amount_due <= 0.01`, which counts every future OTA booking as "paid but
    // unbilled" — it would have paged daily about precisely the reservations the
    // poll is now correctly holding.
    const row: any = await env.DB.prepare(
      `SELECT COUNT(*) AS n, MIN(b.created_at) AS oldest, SUM(COALESCE(b.total_amount,0)) AS value
         FROM lodgify_bookings b
        WHERE b.user_id = ?1
          AND b.status = 'Booked'
          AND (?2 IS NULL OR b.created_at >= ?2)
          AND ${otaSql ? `(${collectedSqlPredicate()} OR ${otaSql})` : collectedSqlPredicate()}
          AND b.created_at <= ?3
          ${notBilled}`
    ).bind(userId, invoiceCutoff ?? null, graceIso).first();

    const n = Number(row?.n ?? 0);
    if (n > 0) {
      console.warn(`[LodgifyPoll] user ${userId}: ${n} paid booking(s) still uninvoiced (oldest ${row?.oldest})`);
      await reportIncident(env, {
        user_id: userId,
        severity: "critical",
        kind: "queue_retry_exhausted",
        summary: `${n} reserva(s) Lodgify pagas continuam por facturar (mais antiga: ${String(row?.oldest ?? "?").slice(0, 10)}).`,
        detail: {
          uninvoiced: n, oldest: row?.oldest, value: row?.value,
          // Aggregate alert: there is no single destination error behind it, so
          // say what the condition IS rather than leaving triage with nothing.
          message: `${n} reserva(s) Lodgify pagas sem documento emitido (mais antiga: ${String(row?.oldest ?? "?").slice(0, 10)}, valor total ${row?.value ?? "?"}). Não houve recusa do destino — as reservas nunca chegaram a ser facturadas.`,
        },
        connection_label: connLabel,
        bucket: "daily",
      });
    }

    // (2) The counterweight to a manual trigger. Invoicing waits for the
    // merchant to mark a booking paid in Lodgify, so a forgotten booking is
    // simply never billed — silently, which is exactly how 14 of 16 bookings
    // went unbilled for 26 days. A stay that ended days ago with no payment
    // recorded is the signature of that, so say so while it can still be fixed.
    // Deliberately NOT a trigger to invoice: a finished stay is not a payment.
    //
    // On a connection that bills OTA stays on check-out, those bookings are NOT
    // waiting on the merchant for anything — telling them to go mark a Booking
    // .com stay as paid would be advice to ignore, on repeat, daily. Excluded
    // here; query (1) above already counts them if they end up unbilled.
    const stale: any = await env.DB.prepare(
      `SELECT COUNT(*) AS n, MIN(b.departure) AS oldest, SUM(COALESCE(b.total_amount,0)) AS value
         FROM lodgify_bookings b
        WHERE b.user_id = ?1
          AND b.status = 'Booked'
          AND (?2 IS NULL OR b.created_at >= ?2)
          AND ${awaitingPaymentMarkSqlPredicate(3)}
          ${otaSql ? `AND NOT ${otaSql}` : ""}
          ${notBilled}`
    ).bind(userId, invoiceCutoff ?? null).first();

    const m = Number(stale?.n ?? 0);
    if (m > 0) {
      console.warn(`[LodgifyPoll] user ${userId}: ${m} finished stay(s) with no payment recorded (oldest ${stale?.oldest})`);
      await reportIncident(env, {
        user_id: userId,
        severity: "warning",
        kind: "lodgify_payment_not_marked",
        summary: `${m} reserva(s) já terminadas continuam sem pagamento registado no Lodgify — não podem ser facturadas até serem marcadas como pagas (mais antiga saiu a ${String(stale?.oldest ?? "?").slice(0, 10)}).`,
        detail: { awaiting_mark: m, oldest_departure: stale?.oldest, value: stale?.value },
        connection_label: connLabel,
        bucket: "daily",
      });
    }
  } catch (e: any) {
    console.error(`[LodgifyPoll] backlog check failed for ${userId}: ${e?.message ?? e}`);
  }
}

/**
 * Alert when a Lodgify connection has gone too long without a completed
 * ingestion — the "nobody is fetching any more" alarm.
 *
 * Reads the marker `markLodgifyIngest` writes, NOT the mirror's freshness: a
 * merchant can legitimately have zero new bookings for weeks (seasonal, paused,
 * dormant), and paging about that trains everyone to ignore the alert. A run
 * that completed is what we actually require, and it happens whether or not the
 * merchant sold anything.
 *
 * 6h threshold against an hourly feeder = five consecutive missed runs before
 * anyone is woken. Daily bucket, so a dead feeder costs one email per day.
 */
export async function reportStaleLodgifyIngest(env: Env): Promise<{ checked: number; stale: number; skipped: number }> {
  const out = { checked: 0, stale: 0, skipped: 0 };
  const rows = await env.DB.prepare(
    `SELECT user_id, destination_kind FROM connections WHERE source_kind = 'lodgify' AND status = 'active'`
  ).all();

  const staleMs = 6 * 60 * 60 * 1000;
  for (const conn of (rows?.results ?? []) as any[]) {
    // A client we would not invoice for cannot have an ingestion problem worth
    // waking anyone at 08:00 for. Even if every booking arrived on time the gate
    // would refuse to document them, so silence is the correct state and not a
    // symptom — `connections.status` stays "active" long after a subscription
    // ends, which is why the row alone cannot answer this.
    //
    // Casa de Celebrar a Vida is the case: cancelled, dormant until 2027, and
    // sending one critical "as reservas não estão a chegar" every single day.
    // Alarms that are known-wrong are worse than no alarm, because they teach
    // you to skim the ones that are right.
    const gate = await checkSubscriptionGate(env, { user_id: conn.user_id } as IRequestConfig, { source: "lodgify", destination: conn.destination_kind ?? "moloni" });
    if (!gate.allowed) { out.skipped++; continue; }

    out.checked++;
    const state: any = await env.DB.prepare(
      "SELECT last_completed_at FROM sweep_state WHERE shopify_domain = ?"
    ).bind(lodgifyIngestKey(conn.user_id)).first();

    const lastMs = state?.last_completed_at ? Date.parse(String(state.last_completed_at)) : NaN;
    const ageMs = Number.isFinite(lastMs) ? Date.now() - lastMs : Infinity;
    if (ageMs <= staleMs) continue;

    out.stale++;
    const hours = Number.isFinite(ageMs) ? Math.round(ageMs / 3600000) : null;
    await reportIncident(env, {
      user_id: conn.user_id,
      severity: "critical",
      kind: "auth_failure_source",
      summary: hours == null
        ? "Nenhuma sincronização Lodgify alguma vez concluída para esta ligação — as reservas não estão a chegar."
        : `Sem sincronização Lodgify há ${hours}h — as reservas deixaram de chegar e nada está a ser facturado.`,
      detail: { last_completed_at: state?.last_completed_at ?? null, threshold_hours: 6 },
      connection_label: `lodgify → ${conn.destination_kind ?? "moloni"}`,
      bucket: "daily",
    });
  }
  return out;
}
