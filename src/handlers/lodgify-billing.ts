import type { Env } from "../env";
import type { DestinationKind } from "../storage";
import { AppStorage } from "../storage";
import { getDestinationAdapter } from "../adapters/registry";
import { buildAdapterCtx } from "../services/adapter-ctx";
import { cancelReference, cancelReferenceCandidates } from "../services/document-references";

/**
 * Taking back what we billed for a Lodgify booking.
 *
 * A booking is not one document. The progressive path issues one per instalment
 * (`lodgify_partial_invoices`) and the standard path issues one for the whole
 * total (`processed_orders`), so anything that undoes a booking has to consider
 * both — deleting the first instalment and leaving the second orphaned at the
 * destination is the failure this exists to prevent.
 */

export interface TakeBackResult {
  /** Everything we had on record for this booking. */
  invoiceIds: string[];
  /** Gone from the destination (or already absent). */
  deleted: string[];
  /** Undone with a credit note (delete_or_credit only). */
  credited: string[];
  /** Fiscally locked and left standing — needs a human. */
  finalized: string[];
}

export type TakeBackMode =
  /** Drafts only. A certified document is left standing and reported. */
  | "delete_drafts"
  /** Drafts deleted, certified documents credited. */
  | "delete_or_credit";

/**
 * Remove the documents recorded for one booking, and then forget them, so the
 * booking is back to "never billed".
 *
 * Shared by the cancellation path, by `/admin/lodgify/unbill-premature` (which
 * cleans up documents issued under the old settlement rule) and by the generic
 * admin delete-draft / credit-note. All of them need the same care, and it is
 * not the kind of code to have two copies of.
 *
 * Our records are only cleared when EVERY document is gone: a booking still
 * carrying a document we could not undo must keep its rows, or the next poll
 * would see "no invoice" and cheerfully issue a second one.
 */
export async function takeBackLodgifyDocuments(env: Env, o: {
  userId: string;
  bookingId: string;
  destination: DestinationKind;
  config: any;
  sourceCfg: Record<string, any>;
  destinationConfig: Record<string, any> | undefined;
  dryRun: boolean;
  mode?: TakeBackMode;
  reason?: string | null;
  /**
   * Also drop the `processed_orders` row once everything is gone.
   *
   * Off for the poll and the cancellation path, which have never done it — a
   * cancelled booking should stay un-billable. On for the admin tools, where
   * "apagar rascunho" means the same thing it means for every other source:
   * the sale is unbilled and may be billed again.
   */
  forgetStandardRecord?: boolean;
}): Promise<TakeBackResult> {
  const mode: TakeBackMode = o.mode ?? "delete_drafts";
  const appStorage = new AppStorage(env, null, o.userId);

  // Both billing paths keep their own record of what was issued.
  const partials = await appStorage.getPartialInvoices(o.userId, o.bookingId);
  const standard = await appStorage.getInvoiceByOrderId(o.bookingId);
  const invoiceIds = [
    ...partials.map((p) => p.invoice_id).filter((id): id is string => !!id),
    ...(standard?.invoice_id ? [standard.invoice_id] : []),
  ];
  const empty: TakeBackResult = { invoiceIds, deleted: [], credited: [], finalized: [] };
  if (invoiceIds.length === 0) return empty;

  const destAdapter = getDestinationAdapter(o.destination);
  if (!destAdapter.deleteDraft) {
    console.warn(`[Lodgify] ${o.destination} cannot delete drafts — booking ${o.bookingId} left as-is`);
    return empty;
  }
  if (o.dryRun) return empty;

  // The full ctx, not a bare {apiKey, config}: crediting a Moloni document needs
  // the product mappings, and building the ctx by hand is how they went missing.
  const { ctx } = await buildAdapterCtx(env, {
    config: o.config,
    source: "lodgify",
    destination: o.destination,
    sourceConfig: o.sourceCfg,
    destinationConfig: o.destinationConfig,
  });

  const deleted: string[] = [];
  const credited: string[] = [];
  const finalized: string[] = [];

  for (let i = 0; i < invoiceIds.length; i++) {
    const invoiceId = invoiceIds[i];
    try {
      const outcome = await destAdapter.deleteDraft(invoiceId, ctx);
      if (outcome !== "finalized") {
        deleted.push(invoiceId); // "deleted" and "already_gone" both end here
        continue;
      }

      if (mode !== "delete_or_credit" || !destAdapter.creditFullDocument) {
        finalized.push(invoiceId);
        continue;
      }

      // Each document of a multi-instalment booking needs its own reference, or
      // the second credit note would be refused as a duplicate of the first.
      const key = invoiceIds.length > 1 ? `${o.bookingId}-${i + 1}` : o.bookingId;
      const result = await destAdapter.creditFullDocument(invoiceId, ctx, {
        reference: cancelReference("lodgify", key),
        matchReferences: cancelReferenceCandidates("lodgify", key),
        reason: o.reason ?? null,
      });
      credited.push(result.creditId || invoiceId);
    } catch (e: any) {
      console.error(`[Lodgify] taking back ${invoiceId} for booking ${o.bookingId} failed: ${e?.message ?? e}`);
      finalized.push(invoiceId); // unknown state — escalate rather than forget
    }
  }

  if (finalized.length === 0) {
    await appStorage.deletePartialInvoices(o.userId, o.bookingId);
    await appStorage.resetWebhookInfo(o.bookingId, "lodgify/created");
    if (o.forgetStandardRecord && standard?.invoice_id) {
      await appStorage.deleteProcessedInvoice(o.bookingId, "lodgify");
    }
  }
  return { invoiceIds, deleted, credited, finalized };
}
