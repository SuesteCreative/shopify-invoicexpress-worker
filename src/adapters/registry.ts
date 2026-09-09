import type { SourceAdapter, DestinationAdapter, SourceKind, DestinationKind } from "./types";
import { ShopifySource } from "./sources/shopify-source";
import { StripeSource } from "./sources/stripe-source";
import { EuPagoSource } from "./sources/eupago-source";
import { LodgifySource } from "./sources/lodgify-source";
import { InvoiceXpressDestination } from "./destinations/ix-destination";
import { MoloniDestination } from "./destinations/moloni-destination";
import { VendusDestination } from "./destinations/vendus-destination";

const stripeSource = new StripeSource();

const sourceInstances: Partial<Record<SourceKind, SourceAdapter>> = {
  shopify: new ShopifySource(),
  stripe: stripeSource,
  // Connect connections read the same Stripe objects with the same code. The
  // credential swap happens upstream, in resolveStripeAuth, so the adapter has
  // nothing to branch on and a second instance would only be a second thing to
  // keep in sync.
  stripe_connect: stripeSource,
  eupago: new EuPagoSource(),
  lodgify: new LodgifySource(),
};

const destinationInstances: Partial<Record<DestinationKind, DestinationAdapter>> = {
  invoicexpress: new InvoiceXpressDestination(),
  moloni: new MoloniDestination(),
  vendus: new VendusDestination(),
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
