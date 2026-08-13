import type { SourceKind } from "../adapters/types";

/**
 * The reference strings we stamp on documents at every destination.
 *
 * These are not cosmetic. A reference is the ONLY cross-system idempotency key
 * we have: before creating anything we ask the destination "do you already hold
 * a document with this reference?", and the answer decides whether a payment
 * gets invoiced once or twice. Three conventions grew independently —
 *
 *   `OrderRefund #<refundId>`   the pipeline's automatic refund credit note
 *   `OrderCancel #<orderNumber>` the admin "cancel this sale" credit note (Shopify)
 *   `StripeCancel <pi_…>`        the same thing on the Stripe admin path
 *
 * — with the result that a credit note issued by one path is invisible to the
 * other's idempotency check, so the same document can be credited twice. Every
 * new call site must build its references here, and every LOOKUP must go through
 * `cancelReferenceCandidates` so the historical spellings keep resolving.
 */

/** The sale document's reference. `Order #1137`. */
export function saleReference(orderNumber: string | number): string {
  return `Order #${orderNumber}`;
}

/**
 * One instalment of a progressively-billed sale. `Order #1137-2`.
 * Lodgify bookings settle in stages and get one document per stage.
 */
export function partialSaleReference(orderNumber: string | number, seq: number): string {
  return `${saleReference(orderNumber)}-${seq}`;
}

/** Credit note for a refund that actually happened at the source. */
export function refundReference(refundId: string | number): string {
  return `OrderRefund #${refundId}`;
}

/**
 * Refund references live on CREDIT NOTES, not on invoices — Moloni's
 * findByReference has to know which endpoint family to search.
 */
export function isRefundReference(reference: string): boolean {
  return /^OrderRefund /i.test(reference);
}

/**
 * Credit note for an operator cancelling a document after the fact, with no
 * refund at the source.
 *
 * `key` is whatever identifies the sale for that source: the order number for
 * Shopify (do NOT change this — `reconciliation.ts` matches on the exact
 * `OrderCancel #<orderNumber>` spelling), the external id everywhere else.
 */
export function cancelReference(_source: SourceKind, key: string | number): string {
  return `OrderCancel #${key}`;
}

/**
 * Every spelling a cancel credit note may carry, current first.
 *
 * Idempotency lookups MUST iterate this rather than testing `cancelReference`
 * alone: documents credited before the conventions were unified carry the old
 * `StripeCancel <id>` form, and a lookup that misses one issues a second credit
 * note against an already-credited invoice.
 */
export function cancelReferenceCandidates(source: SourceKind, key: string | number): string[] {
  const refs = [cancelReference(source, key)];
  if (source === "stripe") refs.push(`StripeCancel ${key}`);
  return refs;
}
