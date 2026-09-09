import type { Env } from "../env";
import type { SourceKind, DestinationKind } from "../storage";

/**
 * Moloni OAuth2 authorization-code flow.
 *
 * The other Moloni path in this codebase is a password grant: it holds the
 * merchant's username and password forever and mints a token whenever it needs
 * one. This one holds neither, and that changes what the code has to be careful
 * about:
 *
 *  - the access token lives 1 hour;
 *  - the refresh token lives **14 days and rotates on every use** — each refresh
 *    returns a new one and kills the old. So the new pair MUST be persisted, and
 *    two refreshes racing on the same stored token means one of them wins and
 *    the loser is holding a dead token;
 *  - if nothing refreshes for 14 days the merchant has to authorise again. That
 *    is why the nightly cron exists: a shop that sells nothing for a fortnight
 *    would otherwise come back to a broken connection.
 *
 * https://www.moloni.pt/dev/autenticacao/
 */

/** Where the merchant is sent to consent. Not under api.moloni.pt. */
const MOLONI_AUTHORIZE_URL = "https://www.moloni.pt/ac/root/oauth/";

/** Moloni states 14 days; we treat it as 13 to leave a day of margin. */
const REFRESH_TOKEN_TTL_DAYS = 14;
/** Renew when the refresh token has less than this left. */
export const REFRESH_RENEW_WINDOW_DAYS = 7;
/** Refresh the access token this long before it actually expires. */
const ACCESS_TOKEN_SKEW_MS = 5 * 60_000;

export interface MoloniOAuthApp {
  clientId: string;
  clientSecret: string;
  /** API base — production or sandbox, same as the password path uses. */
  baseUrl: string;
}

export interface MoloniOAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** ISO. When the access token stops working. */
  expiresAt: string;
  /** ISO. When the refresh token stops working, i.e. when the merchant must reauthorise. */
  refreshExpiresAt: string;
}

export function moloniBaseUrl(environment?: string | null): string {
  return environment === "sandbox" ? "https://apidemo.moloni.pt/v1" : "https://api.moloni.pt/v1";
}

/**
 * The app credentials for a connection.
 *
 * Reads the merchant's own developer app first, and falls back to a
 * Rioko-owned app in `env`. Both shapes are supported on purpose: Moloni
 * documents the redirect_uri as being for "plugins de instalação em vários
 * sites" but never states that one app may authorise third-party accounts. If it
 * can, setting MOLONI_APP_CLIENT_ID turns the merchant's step into one click and
 * no code changes; if it cannot, every connection carries its own pair and this
 * returns those.
 */
export function resolveMoloniApp(
  env: Pick<Env, "MOLONI_APP_CLIENT_ID" | "MOLONI_APP_CLIENT_SECRET">,
  destinationConfig: Record<string, any> | null | undefined,
): MoloniOAuthApp | null {
  const c = destinationConfig ?? {};
  const clientId = String(c.moloni_client_id ?? "").trim() || String(env.MOLONI_APP_CLIENT_ID ?? "").trim();
  const clientSecret = String(c.moloni_client_secret ?? "").trim() || String(env.MOLONI_APP_CLIENT_SECRET ?? "").trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, baseUrl: moloniBaseUrl(c.moloni_environment) };
}

export function buildMoloniAuthorizeUrl(clientId: string, redirectUri: string): string {
  const url = new URL(MOLONI_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  return url.toString();
}

/** Raised when Moloni refuses the credential itself, as opposed to failing to answer. */
export class MoloniReauthRequired extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoloniReauthRequired";
  }
}

function toTokens(body: any): MoloniOAuthTokens {
  const accessToken = String(body?.access_token ?? "");
  const refreshToken = String(body?.refresh_token ?? "");
  if (!accessToken || !refreshToken) {
    // A grant that returns only an access token would work for an hour and then
    // strand the connection with nothing to refresh from. Treat it as a failure
    // now rather than as a mystery tomorrow.
    throw new Error("Moloni OAuth: grant response missing access_token or refresh_token");
  }
  const expiresIn = Number(body?.expires_in ?? 3600);
  const now = Date.now();
  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(now + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000).toISOString(),
    refreshExpiresAt: new Date(now + REFRESH_TOKEN_TTL_DAYS * 86_400_000).toISOString(),
  };
}

async function grant(app: MoloniOAuthApp, params: Record<string, string>): Promise<MoloniOAuthTokens> {
  const url = new URL(`${app.baseUrl}/grant/`);
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("client_secret", app.clientSecret);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* Moloni occasionally answers HTML on an error */ }

  if (!res.ok) {
    // 400/401 here means the code or refresh token is spent, revoked or expired.
    // No retry will fix that: only the merchant can, by authorising again.
    const detail = String(body?.error_description ?? body?.error ?? text).slice(0, 200);
    if (res.status === 400 || res.status === 401) {
      throw new MoloniReauthRequired(`Moloni OAuth rejected the grant (${res.status}): ${detail}`);
    }
    throw new Error(`Moloni OAuth grant failed (${res.status}): ${detail}`);
  }
  return toTokens(body);
}

export function exchangeMoloniCode(app: MoloniOAuthApp, code: string, redirectUri: string): Promise<MoloniOAuthTokens> {
  return grant(app, { grant_type: "authorization_code", redirect_uri: redirectUri, code });
}

export function refreshMoloniTokens(app: MoloniOAuthApp, refreshToken: string): Promise<MoloniOAuthTokens> {
  return grant(app, { grant_type: "refresh_token", refresh_token: refreshToken });
}

/** The fields a set of tokens occupies inside `destination_config_json`. */
export function tokensToConfigPatch(t: MoloniOAuthTokens): Record<string, string> {
  return {
    moloni_auth_mode: "oauth",
    moloni_access_token: t.accessToken,
    moloni_refresh_token: t.refreshToken,
    moloni_token_expires_at: t.expiresAt,
    moloni_refresh_expires_at: t.refreshExpiresAt,
  };
}

export function isMoloniOAuthConfig(destinationConfig: Record<string, any> | null | undefined): boolean {
  return destinationConfig?.moloni_auth_mode === "oauth";
}

export interface MoloniTokenProviderTarget {
  userId: string;
  source: SourceKind;
  destination: DestinationKind;
  /** The live, in-memory config for this run. Updated in place after a rotation. */
  destinationConfig: Record<string, any>;
}

export interface MoloniTokenProvider {
  /** A usable access token, refreshing and persisting the rotation if needed. */
  get(): Promise<string>;
}

/**
 * Persist a rotated pair, but only if nobody else rotated first.
 *
 * Compare-and-set on the refresh token we started from, the same shape as the
 * `order_claims` guard. Without it, two queue messages for the same merchant
 * refreshing at the same second would both succeed at Moloni, and the second
 * write would store a refresh token that the first had already invalidated —
 * the connection dies an hour later for no visible reason.
 *
 * Returns false when the CAS lost, which is not an error: it means another
 * worker already stored a newer, valid pair.
 */
async function persistRotation(
  env: Pick<Env, "DB">,
  target: MoloniTokenProviderTarget,
  previousRefreshToken: string,
  tokens: MoloniOAuthTokens,
): Promise<boolean> {
  const patch = JSON.stringify(tokensToConfigPatch(tokens));
  const now = new Date().toISOString();
  const res: any = await env.DB.prepare(
    `UPDATE connections
        SET destination_config_json = json_patch(COALESCE(destination_config_json, '{}'), ?),
            last_token_refresh_at = ?,
            updated_at = ?
      WHERE user_id = ? AND source_kind = ? AND destination_kind = ?
        AND json_extract(destination_config_json, '$.moloni_refresh_token') = ?`
  ).bind(patch, now, now, target.userId, target.source, target.destination, previousRefreshToken).run();

  return (res?.meta?.changes ?? 0) > 0;
}

/** Re-read the row after losing a CAS, to pick up whatever the winner stored. */
async function reloadTokens(
  env: Pick<Env, "DB">,
  target: MoloniTokenProviderTarget,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: string } | null> {
  const row: any = await env.DB.prepare(
    `SELECT destination_config_json FROM connections
      WHERE user_id = ? AND source_kind = ? AND destination_kind = ? LIMIT 1`
  ).bind(target.userId, target.source, target.destination).first();
  if (!row?.destination_config_json) return null;
  let cfg: any;
  try { cfg = JSON.parse(row.destination_config_json); } catch { return null; }
  const accessToken = String(cfg?.moloni_access_token ?? "");
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: String(cfg?.moloni_refresh_token ?? ""),
    expiresAt: String(cfg?.moloni_token_expires_at ?? ""),
  };
}

/**
 * Mark the connection as needing the merchant's attention.
 *
 * Deliberately narrow: only Moloni refusing the credential lands here. A timeout
 * or a 500 leaves the connection alone, because the queue will retry and a
 * transient blip must not take a working merchant offline.
 */
async function markReauthRequired(env: Pick<Env, "DB">, target: MoloniTokenProviderTarget, reason: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE connections SET status = 'error', updated_at = ?,
            destination_config_json = json_patch(COALESCE(destination_config_json, '{}'), ?)
      WHERE user_id = ? AND source_kind = ? AND destination_kind = ? AND status = 'active'`
  ).bind(
    now,
    JSON.stringify({ moloni_oauth_error: reason.slice(0, 300), moloni_oauth_error_at: now }),
    target.userId, target.source, target.destination,
  ).run();
}

export function createMoloniTokenProvider(
  env: Pick<Env, "DB" | "MOLONI_APP_CLIENT_ID" | "MOLONI_APP_CLIENT_SECRET">,
  target: MoloniTokenProviderTarget,
): MoloniTokenProvider | null {
  const app = resolveMoloniApp(env, target.destinationConfig);
  if (!app) return null;

  // One in-flight refresh per provider. getAccessToken is called ~10 times while
  // one document is issued, and without this the first document after expiry
  // would fire ten simultaneous refreshes and rotate the token out from under
  // itself nine times.
  let inFlight: Promise<string> | null = null;

  const fresh = (): string | null => {
    const cfg = target.destinationConfig;
    const token = String(cfg.moloni_access_token ?? "");
    const expiresAt = Date.parse(String(cfg.moloni_token_expires_at ?? ""));
    if (!token) return null;
    if (!Number.isFinite(expiresAt)) return null;
    return expiresAt - ACCESS_TOKEN_SKEW_MS > Date.now() ? token : null;
  };

  const refresh = async (): Promise<string> => {
    const previousRefreshToken = String(target.destinationConfig.moloni_refresh_token ?? "");
    if (!previousRefreshToken) {
      throw new MoloniReauthRequired("Moloni OAuth: no refresh token stored — the merchant has to authorise again");
    }

    let tokens: MoloniOAuthTokens;
    try {
      tokens = await refreshMoloniTokens(app, previousRefreshToken);
    } catch (e: any) {
      if (e instanceof MoloniReauthRequired) {
        await markReauthRequired(env, target, e.message);
      }
      throw e;
    }

    const won = await persistRotation(env, target, previousRefreshToken, tokens);
    if (!won) {
      const current = await reloadTokens(env, target);
      if (current) {
        Object.assign(target.destinationConfig, {
          moloni_access_token: current.accessToken,
          moloni_refresh_token: current.refreshToken,
          moloni_token_expires_at: current.expiresAt,
        });
        return current.accessToken;
      }
      // Lost the CAS and the row says nothing useful. Our pair is still the one
      // Moloni just minted, so use it rather than fail the document.
      console.warn("[MoloniOAuth] rotation CAS lost and reload found no token; using the pair we just minted");
    }

    Object.assign(target.destinationConfig, tokensToConfigPatch(tokens));
    return tokens.accessToken;
  };

  return {
    async get(): Promise<string> {
      const cached = fresh();
      if (cached) return cached;
      if (!inFlight) {
        inFlight = refresh().finally(() => { inFlight = null; });
      }
      return inFlight;
    },
  };
}
