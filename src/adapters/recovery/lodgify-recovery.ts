import type { Env } from "../../env";
import type { ConnectionContext } from "../../services/connection-context";
import type { SourceRecovery, SourceRecordRef, SourceDescription } from "./types";
import { toPreloadedFromItem } from "../../services/lodgify-booking";
import {
  bookingCollectedAmount, collectedSqlPredicate,
  isOtaStayCollected, otaStayCollectedSqlPredicate, otaPolicyFrom, type OtaPolicy,
} from "../../services/lodgify-amounts";

/**
 * Lodgify recovery reads the D1 mirror (`lodgify_bookings.raw_json`), not the
 * Lodgify API.
 *
 * Not a shortcut: Lodgify 429-blocked the Worker's egress IP as an "unregistered
 * API user requesting data for multiple end users", so an admin tool that hit
 * the API per booking would be the first thing to break. The mirror is refreshed
 * by the half-hourly poll; when it is stale, so is this, and the poll is the
 * thing to fix.
 */

const CANCELLED_STATUSES = new Set(["declined", "cancelled", "canceled"]);

/**
 * Why this booking must not be billed, or null if it may be.
 *
 * This is load-bearing and cannot be delegated: handing the pipeline a
 * `_preloaded_booking` makes LodgifySource SKIP its own settlement gate, on the
 * grounds that whoever preloaded the data already applied it. So the rule is
 * applied here, from the same helpers the poll uses.
 */
export function blockerFor(item: any, policy?: OtaPolicy): string | null {
  const status = String(item?.status ?? "").toLowerCase();
  if (CANCELLED_STATUSES.has(status)) return `reserva ${item?.status}`;

  const settlement = bookingCollectedAmount(item);
  switch (settlement.basis) {
    case "zero_total":
      return "reserva sem valor a facturar";
    case "awaiting_payment":
      // Opted-in connections bill an OTA stay once it has happened — the channel
      // collected the money and it never passes through Lodgify, so there is
      // nothing for the merchant to mark. Still blocked before the stay ends.
      if (isOtaStayCollected(item, policy)) return null;
      return "sem pagamento registado no Lodgify — o merchant ainda não a marcou como paga";
    case "instalment":
      // Deliberate: a part-paid booking is billed in instalments, and that
      // ledger (lodgify_partial_invoices) belongs to the poll. Issuing one
      // document for the whole total here would bill money nobody has received.
      return `liquidação parcial (${settlement.collected.toFixed(2)} €) — facturada em prestações pelo poll`;
    case "paid_in_full":
      // `basis` is derived from whether `collected` covers the total, so this
      // case IS isBookingFullyCollected — the re-check that used to sit here was
      // guarding against the basis being computed from Lodgify's balance field.
      return null;
  }
}

function toRecord(row: any, item: any, policy?: OtaPolicy): SourceRecordRef {
  const bookingId = String(row?.id ?? item?.id ?? "");
  const settlement = bookingCollectedAmount(item);
  // An opted-in OTA stay has no recorded payment by definition, so report the
  // booking total as what will be billed — otherwise the dry-run preview shows
  // "would bill ? €" for exactly the records this policy exists to bill.
  const otaTotal = settlement.collected <= 0 && isOtaStayCollected(item, policy)
    ? Number(item?.total_amount ?? item?.total ?? 0)
    : 0;
  return {
    externalId: bookingId,
    // Lodgify has no order numbers; the document reference derives a numeric
    // from the booking id, which is not something an operator ever types.
    orderNumber: null,
    label: `LOD-${bookingId}`,
    paidTotal: settlement.collected > 0 ? settlement.collected : (otaTotal > 0 ? otaTotal : null),
    paidAt: row?.updated_at ?? row?.created_at ?? null,
    replayBody: {
      event: "booking_new_status_booked",
      data: { bookingId: Number(bookingId) || bookingId },
      _preloaded_booking: toPreloadedFromItem(item),
    },
    blocker: blockerFor(item, policy),
  };
}

function parseRow(row: any): { row: any; item: any } | null {
  if (!row) return null;
  let item: any = null;
  try { item = row.raw_json ? JSON.parse(row.raw_json) : null; } catch { item = null; }
  // Without raw_json there is no booking to normalize from. The mirrored columns
  // are for querying, not for rebuilding the payload.
  if (!item) return null;
  return { row, item };
}

export class LodgifyRecovery implements SourceRecovery {
  readonly kind = "lodgify" as const;

  async resolveRecord(input: string, ctx: ConnectionContext, env: Env): Promise<SourceRecordRef | null> {
    const bookingId = input.trim().replace(/^LOD-/i, "");
    const row: any = await env.DB.prepare(
      "SELECT * FROM lodgify_bookings WHERE user_id = ? AND id = ? LIMIT 1"
    ).bind(ctx.userId, bookingId).first();

    const parsed = parseRow(row);
    if (!parsed) {
      throw new Error(
        `Reserva ${bookingId} não está no espelho local. Corra /admin/lodgify/poll para sincronizar antes de a re-emitir.`,
      );
    }
    return toRecord(parsed.row, parsed.item, otaPolicyFrom(ctx.destinationConfig));
  }

  async listCandidates(
    ctx: ConnectionContext,
    env: Env,
    window: { from: string; to: string; limit: number },
  ): Promise<SourceRecordRef[]> {
    // `collectedSqlPredicate` keeps the SQL in lockstep with
    // bookingCollectedAmount — the two expressions of that one rule drifting
    // apart is how the backlog alert once counted every future OTA booking as
    // unbilled revenue.
    // An opted-in connection also bills OTA stays that have happened, which by
    // definition have no recorded payment — without widening the SQL here they
    // would never even reach `blockerFor`, and the backfill would report an
    // empty window for exactly the bookings the policy exists to bill.
    const policy = otaPolicyFrom(ctx.destinationConfig);
    const otaSql = otaStayCollectedSqlPredicate(policy);
    const billable = otaSql ? `(${collectedSqlPredicate()} OR ${otaSql})` : collectedSqlPredicate();

    const rows = await env.DB.prepare(
      `SELECT * FROM lodgify_bookings b
        WHERE b.user_id = ?
          AND COALESCE(b.created_at, b.synced_at) >= ?
          AND COALESCE(b.created_at, b.synced_at) <= ?
          AND ${billable}
        ORDER BY COALESCE(b.created_at, b.synced_at) ASC
        LIMIT ?`
    ).bind(ctx.userId, window.from, window.to, window.limit).all();

    const out: SourceRecordRef[] = [];
    for (const row of (rows.results ?? []) as any[]) {
      const parsed = parseRow(row);
      if (parsed) out.push(toRecord(parsed.row, parsed.item, policy));
    }
    return out;
  }

  async describe(externalIds: string[], ctx: ConnectionContext, env: Env): Promise<Map<string, SourceDescription>> {
    const map = new Map<string, SourceDescription>();
    if (externalIds.length === 0) return map;

    for (let i = 0; i < externalIds.length; i += 50) {
      const chunk = externalIds.slice(i, i + 50);
      const ph = chunk.map(() => "?").join(",");
      const rows = await env.DB.prepare(
        `SELECT * FROM lodgify_bookings WHERE user_id = ? AND id IN (${ph})`
      ).bind(ctx.userId, ...chunk).all();

      for (const row of (rows.results ?? []) as any[]) {
        const parsed = parseRow(row);
        if (!parsed) continue;
        const settlement = bookingCollectedAmount(parsed.item);
        map.set(String(row.id), {
          orderNumber: null,
          paidTotal: settlement.collected > 0 ? settlement.collected : null,
          paidAt: row.updated_at ?? row.created_at ?? null,
        });
      }
    }
    return map;
  }
}
