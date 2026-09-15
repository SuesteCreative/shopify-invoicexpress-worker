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

/**
 * The sale document's reference. `Order #1137`.
 *
 * Pass an identifier that is UNIQUE PER SALE. Shopify and Lodgify have a real
 * order number; sources that don't (Stripe, EuPago) must pass their own stable
 * id — see `stripeStableId`. Passing a constant is not a cosmetic mistake: on
 * 2026-08-13 the Stripe source passed its hardcoded `order_number: 0`, so every
 * payment was documented as "Order #0", and the moment Moloni gained a
 * findByReference idempotency check every subsequent Stripe payment was
 * discarded as a duplicate of the first one ever issued.
 */
export function saleReference(orderNumber: string | number): string {
  return `Order #${orderNumber}`;
}

/**
 * THE reference for a sale's document — the single expression every destination
 * writes with and every idempotency check looks up by.
 *
 * It exists because the same `invoice_reference ?? saleReference(order_number)`
 * fallback was open-coded in some places and not others: Moloni and the pipeline
 * honoured `invoice_reference`, InvoiceXpress ignored it (so Lodgify instalments
 * lost their `-seq` suffix and every Stripe sale collapsed onto one reference),
 * and Vendus wrote a bare `order.reference` that the pipeline then searched for
 * under a different spelling. Route every new call site through here.
 */
export function documentReference(order: { invoice_reference?: string | null; order_number: string | number }): string {
  return order.invoice_reference ?? saleReference(order.order_number);
}

/**
 * The spellings the SAME sale may already be filed under by a system that is not
 * Rioko — the merchant's own backoffice, or the connector that came before us.
 *
 * `saleReference` is Rioko's spelling and nobody else's, so an idempotency check
 * that only looks for it answers "has Rioko issued this?" while pretending to
 * answer "does a document for this payment exist?". Everything another system
 * writes is invisible to it, and the merchant gets a second fiscal document for
 * a payment that already had one. The other systems file the bare payment id;
 * the older Stripe connectors prefixed it `#stripe_`.
 *
 * Deliberately narrow: only a payment-processor id, which is globally unique and
 * therefore safe to refuse a document over. A bare order number would match
 * another sale's document, and the instalment references built from one
 * (`Order #1137-2`) would match each other.
 */
export function crossSystemReferences(reference: string): string[] {
  const bare = reference.replace(/^Order #/i, "").trim();
  if (!bare || bare === reference) return [];
  const m = bare.match(/^(pi|ch|cs|in|py|seti)_([A-Za-z0-9]+)$/);
  if (!m) return [];
  // Three spellings, and the third is the one that matters most.
  //
  // The merchant's own backoffice writes the id as Stripe gives it. The older
  // connectors prefixed `#stripe_`, and SOME of them dropped Stripe's own type
  // prefix first — measured on Escola Lá Fora, every one of the 52 documents
  // issued in August 2025 reads `#stripe_3S1rXXBp3wyQk8MN1Vl48FbV` for the
  // payment `pi_3S1rXXBp3wyQk8MN1Vl48FbV`.
  //
  // Missing that form cost 48 duplicate drafts on 15/09/2026: a backfill over a
  // month that was already fully invoiced found no match for any of them and
  // issued the lot again.
  return [bare, `#stripe_${bare}`, `#stripe_${m[2]}`];
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
 *
 * BOTH Stripe kinds, because `issueStripeCreditNote` writes `StripeCancel <id>`
 * for both — it is one code path and the reference does not depend on the kind.
 * Listing it for `stripe` alone meant a Connect credit note was written under a
 * spelling the next idempotency check did not look for, so the same invoice
 * could be credited twice; and a merchant migrated from a restricted key to
 * Connect stopped being able to find their own historical credit notes.
 */
export function cancelReferenceCandidates(source: SourceKind, key: string | number): string[] {
  const refs = [cancelReference(source, key)];
  if (source === "stripe" || source === "stripe_connect") refs.push(`StripeCancel ${key}`);
  return refs;
}
