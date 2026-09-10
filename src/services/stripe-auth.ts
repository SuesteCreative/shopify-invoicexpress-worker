import type { Env } from "../env";

/**
 * Which credential talks to a merchant's Stripe account.
 *
 * Two connection kinds reach the same API by different doors:
 *
 *   stripe          — the merchant pasted a restricted key. We authenticate AS
 *                     their account: the key is theirs, no Stripe-Account header
 *                     is needed (and none was ever sent).
 *   stripe_connect  — the merchant authorised us through Connect OAuth. We hold
 *                     no key of theirs, only an `acct_…`. We authenticate with
 *                     the PLATFORM key and scope each request with
 *                     Stripe-Account, or Stripe answers "no such payment_intent"
 *                     for objects that plainly exist.
 *
 * The branch is `auth_mode`, which only Connect connections carry. A row written
 * before this existed has no such key, falls into the second branch, and comes
 * out with exactly the credential it had yesterday — that is the point.
 */
export interface StripeAuth {
  /** Bearer token: the merchant's restricted key, or the platform secret key. */
  apiKey: string;
  /**
   * acct_… to scope requests to — set ONLY for Connect connections.
   *
   * Undefined on the restricted-key path even though those rows also store a
   * `stripe_account_id`, so that a call site which sends no header today keeps
   * sending none. The few call sites that already pass `stripe_account_id`
   * spell it out as `auth.connectAccount ?? cfg.stripe_account_id`, which is
   * unchanged for them and correct for Connect.
   */
  connectAccount?: string;
}

/** Same shape whether it came from D1, a queue message or a test fixture. */
export interface StripeAuthSource {
  auth_mode?: string;
  /** false only for a connection authorised against Stripe's test mode. */
  livemode?: boolean;
  restricted_key?: string;
  stripe_restricted_key?: string;
  stripe_account_id?: string;
}

/**
 * Whether an event's mode matches the connection it would be invoiced against.
 *
 * `livemode` is written into `source_config_json` by the Connect OAuth callback
 * and, until this existed, was read by nothing at all. A test-mode event whose
 * `account` matched an active row — or, on the legacy route, whose signature
 * verified against a merchant's secret — went straight through to Moloni or
 * InvoiceXpress and became a real fiscal document out of money that does not
 * exist.
 *
 * A connection that states nothing is treated as LIVE. Every existing one is:
 * the field only began being written when Connect shipped. That makes the guard
 * closed by default — a test event is refused unless a connection has said, in
 * writing, that it is a test connection.
 *
 * An event that states nothing is also treated as live, because Stripe always
 * sends the field and its absence means we are not looking at a Stripe event.
 */
export function livemodeMatches(
  sourceConfigJson: string | null | undefined,
  eventLivemode: unknown,
): boolean {
  let cfg: Record<string, any> = {};
  try { cfg = sourceConfigJson ? JSON.parse(sourceConfigJson) : {}; } catch { cfg = {}; }
  const connectionIsLive = cfg.livemode !== false;
  const eventIsLive = eventLivemode !== false;
  return connectionIsLive === eventIsLive;
}

export function isConnectConfig(sourceConfig: StripeAuthSource | null | undefined): boolean {
  return sourceConfig?.auth_mode === "connect";
}

/**
 * Resolve the credential for a Stripe connection, or null when the connection
 * has none usable.
 *
 * Returns null rather than throwing because both callers that can hit it — the
 * nightly heal and reconciliation — already treat a credential-less connection
 * as "skip, not an incident", and a throw there would turn a merchant who never
 * finished the wizard into a nightly alert.
 */
export function resolveStripeAuth(
  env: Pick<Env, "STRIPE_PLATFORM_SECRET_KEY" | "STRIPE_PLATFORM_SECRET_KEY_TEST">,
  sourceConfig: StripeAuthSource | null | undefined,
): StripeAuth | null {
  if (!sourceConfig) return null;

  if (isConnectConfig(sourceConfig)) {
    // A test-mode connected account read with the live key answers 404. The
    // connection records which mode it was authorised in; anything that never
    // said is live, which is every connection made before test mode existed.
    const apiKey = (sourceConfig as any).livemode === false
      ? env.STRIPE_PLATFORM_SECRET_KEY_TEST
      : env.STRIPE_PLATFORM_SECRET_KEY;
    const connectAccount = sourceConfig.stripe_account_id;
    // A Connect connection without one of these cannot read anything. Half a
    // credential is not a credential.
    if (!apiKey || !connectAccount) return null;
    return { apiKey, connectAccount };
  }

  // Legacy restricted-key path, byte-for-byte what every caller in the worker
  // did before this function existed.
  //
  // Deliberately does NOT also read `stripe_restricted_key`. That older spelling
  // is read by one backoffice route and by nothing in the worker, so accepting it
  // here would START enriching a connection that gets no enrichment today — an
  // improvement, maybe, but an unrequested change to live invoicing.
  const apiKey = sourceConfig.restricted_key;
  if (!apiKey) return null;
  return { apiKey };
}

/**
 * The same answer, for code that holds an AdapterCtx and no Env.
 *
 * `buildAdapterCtx` resolves `stripeAuth` once per run. The fallback covers the
 * callers that still hand-roll a bare `{ apiKey, config }` ctx: they only ever
 * did restricted-key work, so reading the key straight off the config keeps them
 * on exactly the behaviour they have today.
 */
export function ctxStripeAuth(ctx: {
  stripeAuth?: StripeAuth;
  sourceConfig?: Record<string, any>;
}): StripeAuth | null {
  if (ctx.stripeAuth) return ctx.stripeAuth;
  const apiKey = ctx.sourceConfig?.restricted_key;
  return apiKey ? { apiKey } : null;
}
