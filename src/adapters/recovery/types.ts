import type { Env } from "../../env";
import type { SourceKind } from "../../storage";
import type { ConnectionContext } from "../../services/connection-context";

/**
 * One billable record at the source, in the shape the recovery engine needs.
 *
 * The engine never sees a Shopify order, a Stripe PaymentIntent or a Lodgify
 * booking — it sees these. That is what lets one backfill/re-emit implementation
 * serve every connection instead of one per source.
 */
export interface SourceRecordRef {
  /**
   * The processed_orders key.
   *
   * MUST equal `getSourceAdapter(kind).externalId(replayBody)`. Violating that
   * is not a cosmetic inconsistency: a forced re-emit deletes the dedup row
   * under THIS id and the pipeline then writes under the adapter's id, so the
   * original row survives and the re-emit is skipped as "Already processed".
   * A Stripe card payment fires both `charge.succeeded` and
   * `payment_intent.succeeded` and the row is keyed on the payment intent —
   * that is the trap this invariant exists for.
   */
  externalId: string;
  /** The number a human reads. Null for sources that have none. */
  orderNumber: number | null;
  /** What to call this record in a result row: "#1137", "pi_3Tp…", "LOD-4429". */
  label: string;
  /** What the buyer actually paid, so finalize can refuse a drifted document. */
  paidTotal: number | null;
  paidAt: string | null;
  /** Webhook-shaped payload to hand `runAdapterPipeline`. */
  replayBody: unknown;
  /**
   * Why this record must NOT be invoiced ("not paid", "cancelled", "pre-cutoff").
   * Present means the engine reports it as skipped rather than billing it.
   */
  blocker?: string | null;
}

export interface SourceDescription {
  orderNumber: number | null;
  paidTotal: number | null;
  paidAt: string | null;
}

/**
 * How the admin recovery tools read a source.
 *
 * Deliberately NOT extra methods on `SourceAdapter`: that one takes a
 * webhook-shaped body on the hot path, while this takes operator input and time
 * windows and needs `env` for D1. Bolting them together would drag admin and
 * database concerns into every webhook delivery.
 */
export interface SourceRecovery {
  readonly kind: SourceKind;

  /** Resolve whatever an operator typed into one record. Null when not found. */
  resolveRecord(input: string, ctx: ConnectionContext, env: Env): Promise<SourceRecordRef | null>;

  /** Everything billable in a window, for a backfill. */
  listCandidates(
    ctx: ConnectionContext,
    env: Env,
    window: { from: string; to: string; limit: number },
  ): Promise<SourceRecordRef[]>;

  /**
   * Order numbers and paid totals for records we already invoiced, keyed by
   * external id. Used by finalize (to refuse certifying a drifted total) and by
   * the order-number range filter. An empty map means "cannot answer", and every
   * caller must treat it as such rather than as "nothing matched".
   */
  describe?(externalIds: string[], ctx: ConnectionContext, env: Env): Promise<Map<string, SourceDescription>>;
}
