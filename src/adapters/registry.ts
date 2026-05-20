import type { SourceAdapter, DestinationAdapter, SourceKind, DestinationKind } from "./types";
import { ShopifySource } from "./sources/shopify-source";
import { StripeSource } from "./sources/stripe-source";
import { InvoiceXpressDestination } from "./destinations/ix-destination";

const sourceInstances: Partial<Record<SourceKind, SourceAdapter>> = {
  shopify: new ShopifySource(),
  stripe: new StripeSource(),
};

const destinationInstances: Partial<Record<DestinationKind, DestinationAdapter>> = {
  invoicexpress: new InvoiceXpressDestination(),
};

export function getSourceAdapter(kind: SourceKind): SourceAdapter {
  const a = sourceInstances[kind];
  if (!a) throw new Error(`Unknown source adapter: ${kind}`);
  return a;
}

export function getDestinationAdapter(kind: DestinationKind): DestinationAdapter {
  const a = destinationInstances[kind];
  if (!a) throw new Error(`Unknown destination adapter: ${kind}`);
  return a;
}
