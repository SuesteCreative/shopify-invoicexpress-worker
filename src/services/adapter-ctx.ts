import type { Env } from "../env";
import type { IRequestConfig, SourceKind, DestinationKind } from "../storage";
import type { AdapterCtx } from "../adapters/types";
import { loadProductMappings } from "./product-mappings";
import { loadProductOverrides } from "./product-overrides";
import { loadTagRoutingRules, type TagRoutingRule } from "./tag-routing";
import { makeViesChecker } from "../ix/vies";
import { resolveLodgifyGateway } from "./lodgify-api";

/**
 * Everything the adapters need to be handed, fetched in one place.
 *
 * The pipeline built this inline, which meant every OTHER caller that reached
 * for an adapter — the Lodgify take-back, reconciliation's metadata fetcher, the
 * admin recovery handlers — hand-rolled a bare `{ apiKey, config }` instead.
 * That is invisible for `deleteDraft`, which needs nothing else, and wrong for
 * anything that writes a document: without `productMappings` the Moloni adapter
 * cannot resolve a mapped product and falls back to find-or-create by reference,
 * silently issuing lines against the wrong product.
 *
 * Takes the connection's shape (a `ConnectionContext` satisfies it as-is) so
 * there is one way to get a ctx, whether the caller came from a webhook or from
 * an operator pressing a button.
 */
export interface AdapterCtxInput {
  config: IRequestConfig;
  source: SourceKind;
  destination: DestinationKind;
  sourceConfig?: Record<string, any>;
  destinationConfig?: Record<string, any>;
}

export async function buildAdapterCtx(
  env: Env,
  input: AdapterCtxInput,
): Promise<{ ctx: AdapterCtx; tagRoutingRules: TagRoutingRule[] }> {
  const { config, source, destination } = input;

  // Explicit product mappings (Moloni) + per-SKU overrides (IX) + tag routing
  // rules. All are one D1 round-trip with empty fallbacks.
  const [productMappings, productOverrides, tagRoutingRules] = await Promise.all([
    destination === "moloni" && config.user_id
      ? loadProductMappings(env, config.user_id, source)
      : Promise.resolve(undefined),
    destination === "invoicexpress" && config.user_id
      ? loadProductOverrides(env, config.user_id, source, destination)
      : Promise.resolve(undefined),
    (destination === "invoicexpress" || destination === "moloni") && config.user_id
      ? loadTagRoutingRules(env, config.user_id, source, destination)
      : Promise.resolve([]),
  ]);

  // Built once per run when reverse-charge is enabled. Without it, B2B EU
  // customers with valid VAT IDs get B2C invoices on the adapter path.
  const viesChecker = config.b2b_reverse_charge === 1 ? makeViesChecker(env.INVOICE_KV) : undefined;

  return {
    ctx: {
      apiKey: env.NORMALIZE_SHOPIFY_ORDER_API_KEY,
      config,
      sourceConfig: input.sourceConfig,
      destinationConfig: input.destinationConfig,
      productMappings,
      productOverrides,
      viesChecker,
      // Lodgify only. Resolving it here means every caller that reaches for an
      // adapter — webhook, poll, take-back, admin button — gets the same egress
      // decision, and a misconfigured relay throws HERE rather than each call
      // site quietly falling back to a direct, unallowlisted request.
      lodgifyGateway: source === "lodgify" ? resolveLodgifyGateway(env) : undefined,
    },
    tagRoutingRules: tagRoutingRules ?? [],
  };
}
