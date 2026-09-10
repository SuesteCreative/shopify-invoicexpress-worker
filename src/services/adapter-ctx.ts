import type { Env } from "../env";
import type { IRequestConfig, SourceKind, DestinationKind } from "../storage";
import type { AdapterCtx } from "../adapters/types";
import { loadProductMappings } from "./product-mappings";
import { loadProductOverrides } from "./product-overrides";
import { loadTagRoutingRules, type TagRoutingRule } from "./tag-routing";
import { makeViesChecker } from "../ix/vies";
import { resolveLodgifyGateway } from "./lodgify-api";
import { projectConnectionBehaviour } from "./connection-context";
import { resolveStripeAuth } from "./stripe-auth";
import { createMoloniTokenProvider, isMoloniOAuthConfig } from "./moloni-oauth";

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

  // The connection's own settings win over the shared legacy row, HERE, because
  // this is the one function every adapter path goes through. The projection
  // used to live at each call site instead: the Stripe queue consumer and the
  // Lodgify poll remembered it, the EuPago webhook and three admin routes did
  // not, and a connection's series or exemption code reached a document or not
  // depending on which door the run came in by. Idempotent, so the call sites
  // that already do it stay correct.
  projectConnectionBehaviour(config, input.destinationConfig, source);

  // Explicit product mappings (Moloni) + per-SKU overrides (IX) + tag routing
  // rules. All are one D1 round-trip with empty fallbacks.
  const [productMappings, productOverrides, tagRoutingRules] = await Promise.all([
    destination === "moloni" && config.user_id
      ? loadProductMappings(env, config.user_id, source)
      : Promise.resolve(undefined),
    // Loaded for every destination, not just InvoiceXpress. `product_overrides`
    // is already keyed by destination_kind and the backoffice already writes
    // moloni/vendus rows — they were simply never read. The tax decision treats
    // an override as "the merchant already decided this line", which has to be
    // true wherever the document is issued.
    config.user_id
      ? loadProductOverrides(env, config.user_id, source, destination)
      : Promise.resolve(undefined),
    (destination === "invoicexpress" || destination === "moloni") && config.user_id
      ? loadTagRoutingRules(env, config.user_id, source, destination)
      : Promise.resolve([]),
  ]);

  // Built once per run when anything might ask whether a buyer is a registered
  // business: the legacy Shopify reverse charge (`b2b_reverse_charge`), the
  // pipeline's own registration, or a connection that asked for the regime to be
  // named. Without it an EU VAT number classifies as unverified, which holds a
  // draft rather than certifying a regime nobody checked.
  const wantsVies = config.b2b_reverse_charge === 1
    || config.ix_derive_exemption === 1
    || input.destinationConfig?.b2b_reverse_charge_pipeline === true
    || Number(input.destinationConfig?.b2b_reverse_charge_pipeline) === 1;
  const viesChecker = wantsVies ? makeViesChecker(env.INVOICE_KV) : undefined;

  return {
    ctx: {
      apiKey: env.NORMALIZE_SHOPIFY_ORDER_API_KEY,
      config,
      sourceConfig: input.sourceConfig,
      destinationConfig: input.destinationConfig,
      productMappings,
      productOverrides,
      viesChecker,
      // Stripe only, both kinds. Resolved here because the Connect answer needs
      // the platform key off `env`, which the adapter never sees. A
      // restricted-key connection resolves to its own key and no account, i.e.
      // the exact credential it used before this existed.
      stripeAuth: source === "stripe" || source === "stripe_connect"
        ? (resolveStripeAuth(env, input.sourceConfig) ?? undefined)
        : undefined,
      // Moloni OAuth connections only, and only when we know which row to write
      // a rotated refresh token back to. A password-grant connection gets no
      // provider and takes the untouched path through getAccessToken.
      moloniToken: destination === "moloni"
        && isMoloniOAuthConfig(input.destinationConfig)
        && config.user_id
        ? (createMoloniTokenProvider(env, {
            userId: config.user_id,
            source,
            destination,
            destinationConfig: input.destinationConfig!,
          }) ?? undefined)
        : undefined,
      // Lodgify only. Resolving it here means every caller that reaches for an
      // adapter — webhook, poll, take-back, admin button — gets the same egress
      // decision, and a misconfigured relay throws HERE rather than each call
      // site quietly falling back to a direct, unallowlisted request.
      lodgifyGateway: source === "lodgify" ? resolveLodgifyGateway(env) : undefined,
    },
    tagRoutingRules: tagRoutingRules ?? [],
  };
}
