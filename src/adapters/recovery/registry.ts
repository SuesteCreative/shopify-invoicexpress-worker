import type { SourceKind } from "../../storage";
import type { SourceRecovery } from "./types";
import { ShopifyRecovery } from "./shopify-recovery";
import { StripeRecovery } from "./stripe-recovery";

/**
 * Sources the admin recovery tools can drive.
 *
 * Absent here means "this source cannot be recovered from yet", which the
 * capabilities endpoint reports honestly rather than the panel discovering it by
 * getting a 500. EuPago is webhook-in only with no read API wired, and Lodgify
 * lands with its billing extraction.
 */
const instances: Partial<Record<SourceKind, SourceRecovery>> = {
  shopify: new ShopifyRecovery(),
  stripe: new StripeRecovery(),
};

export function getSourceRecovery(kind: SourceKind): SourceRecovery {
  const r = instances[kind];
  if (!r) throw new Error(`No recovery support for source: ${kind}`);
  return r;
}

export function hasSourceRecovery(kind: SourceKind): boolean {
  return !!instances[kind];
}
