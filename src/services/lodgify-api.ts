/**
 * Single door for every Lodgify API call this Worker makes.
 *
 * WHY THIS EXISTS
 *   Since 2026-08-02 Lodgify blocks the Worker's egress: "This IP address has
 *   been blocked... flagged as an unregistered API user requesting data for
 *   multiple Lodgify end users." Cloudflare Workers have no stable egress IP,
 *   and Lodgify support confirmed in writing (2026-08-18) that they can only
 *   allowlist by IP address — not by API key, not by account. So every Lodgify
 *   call has to leave through one small box with a fixed IPv4, and that box's
 *   address is the thing Lodgify allowlists.
 *
 *   This module is that single door. Nothing else in the codebase may hold a
 *   `https://api.lodgify.com` literal — `lodgify-api.no-direct-calls.test.ts`
 *   enforces it — because a call that slips past the gateway leaves from an
 *   unallowlisted Cloudflare address and re-earns the block for everyone.
 *
 * WHAT IT IS NOT
 *   Not a fix for the account limit. Lodgify's cap ("the limit at the moment is
 *   20 connected users") is a consequence of being an UNREGISTERED third-party
 *   provider; their own docs say to contact the partnership team to register.
 *   The gateway buys a stable identity, not headroom. Partner registration is
 *   the real remedy and runs in parallel.
 */

/** Lodgify's real origin. The ONLY place this literal is allowed to appear. */
export const LODGIFY_DIRECT_BASE = "https://api.lodgify.com";

/**
 * Path prefixes the relay will forward. Exported so the relay's own config is
 * derived from this list rather than retyped: a path added here and not there
 * fails closed (relay 404) instead of silently escaping to a direct call.
 *
 * `/v2/webhooks/` is deliberately present: the backoffice onboarding wizard
 * unsubscribes through it, and an allowlist without it would push that call
 * back to a direct, unallowlisted egress — exactly the fingerprint that got us
 * flagged.
 */
export const LODGIFY_ALLOWED_PATH_PREFIXES = [
  "/v1/reservation",
  "/v2/reservations/",
  "/webhooks/v1/",
  "/v2/webhooks/",
] as const;

/** Header the relay sends on failures IT generated, so "our box is down" is
 *  distinguishable from "Lodgify is down". See `isGatewayFailure`. */
export const GATEWAY_ERROR_HEADER = "X-Rioko-Gateway-Error";

/** Header carrying the shared secret. Never logged, never forwarded upstream. */
export const GATEWAY_KEY_HEADER = "X-Rioko-Gateway-Key";

/** One stable User-Agent for all Lodgify traffic. We want to be identifiable —
 *  the whole point of the fixed IP is that Lodgify can tell who we are. */
export const LODGIFY_USER_AGENT = "Rioko/1.0 (+https://rioko.online; ops@rioko.online)";

const DEFAULT_TIMEOUT_MS = 15_000;

export type LodgifyEgressMode = "gateway" | "direct";

export type LodgifyGateway = {
  /** Origin every path is resolved against. */
  base: string;
  /** Shared secret for the relay, or null when going direct. */
  key: string | null;
  /** True when traffic leaves through the fixed-IP relay. */
  relayed: boolean;
};

/**
 * Minimal shape read off `env`. Loose on purpose so this module stays testable
 * without importing the Worker's whole env type.
 */
export type LodgifyEgressEnv = {
  LODGIFY_EGRESS_MODE?: string;
  LODGIFY_GATEWAY_URL?: string;
  LODGIFY_GATEWAY_KEY?: string;
};

/** Thrown when the egress configuration is incomplete. Deliberately NOT a
 *  fallback to direct: see `resolveLodgifyGateway`. */
export class LodgifyGatewayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LodgifyGatewayConfigError";
  }
}

/**
 * Decide where Lodgify calls leave from — fail-closed by default.
 *
 * THE TRAP THIS AVOIDS. The obvious design is "gateway URL set ⇒ relay, unset
 * ⇒ direct". That makes a lost variable silently restore the blocked behaviour,
 * and `wrangler deploy` from a machine without the full config has dropped this
 * Worker's secrets before (see the header of `scripts/deploy.mjs`). So:
 *
 *   - mode absent, or "gateway"  ⇒ the relay is REQUIRED. Missing URL or key
 *                                  throws; no call goes out unallowlisted.
 *   - mode exactly "direct"      ⇒ today's behaviour, chosen explicitly.
 *
 * `LODGIFY_EGRESS_MODE` and `LODGIFY_GATEWAY_URL` belong in `wrangler.jsonc`
 * `vars` (reviewable in git, survive a bare deploy, contain no secret). Only
 * `LODGIFY_GATEWAY_KEY` is a `wrangler secret`.
 */
export function resolveLodgifyGateway(env: LodgifyEgressEnv | undefined): LodgifyGateway {
  const raw = (env?.LODGIFY_EGRESS_MODE ?? "").trim().toLowerCase();
  const mode: LodgifyEgressMode = raw === "direct" ? "direct" : "gateway";

  if (mode === "direct") {
    return { base: LODGIFY_DIRECT_BASE, key: null, relayed: false };
  }

  const url = (env?.LODGIFY_GATEWAY_URL ?? "").trim().replace(/\/+$/, "");
  const key = (env?.LODGIFY_GATEWAY_KEY ?? "").trim();

  if (!url || !key) {
    const missing = [!url && "LODGIFY_GATEWAY_URL", !key && "LODGIFY_GATEWAY_KEY"]
      .filter(Boolean).join(" + ");
    throw new LodgifyGatewayConfigError(
      `Lodgify egress mode is "gateway" but ${missing} is missing. Refusing to `
      + `call Lodgify directly: an unallowlisted egress IP re-earns the block. `
      + `Set the variable, or set LODGIFY_EGRESS_MODE="direct" deliberately.`,
    );
  }

  return { base: url, key, relayed: true };
}

/**
 * Reject anything that could steer the proxied path somewhere else.
 *
 * Booking ids arrive from an inbound webhook that skips HMAC when the
 * connection has no stored secret (the normal state for manually registered
 * webhooks), so a stranger can choose this value. Interpolated raw, a
 * `bookings?limit=9999&x=` or `../` would defeat the relay's path allowlist and
 * burn the allowlisted IP's reputation with someone else's request shape.
 */
export function assertSafePathSegment(value: string | number, label: string): string {
  const s = String(value);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) {
    throw new Error(`Refusing to build a Lodgify path with an unsafe ${label}: ${JSON.stringify(s.slice(0, 80))}`);
  }
  return s;
}

/** `assertSafePathSegment` for booking ids, which is where hostile input lands. */
export function assertSafeBookingId(bookingId: string | number): string {
  return assertSafePathSegment(bookingId, "booking id");
}

/** True when `path` is one the relay is configured to forward. */
export function isAllowedLodgifyPath(path: string): boolean {
  return LODGIFY_ALLOWED_PATH_PREFIXES.some(prefix => path.startsWith(prefix));
}

export type LodgifyFetchOpts = {
  /** Merchant's own Lodgify key. Passed through untouched, never logged. */
  apiKey: string;
  /** Where to send it. Obtain once per request via `resolveLodgifyGateway`. */
  gateway: LodgifyGateway;
  method?: "GET" | "POST" | "DELETE" | "PUT";
  body?: string;
  headers?: Record<string, string>;
  /** Defaults to a 15s timeout: a hung TCP connection to a dead relay would
   *  otherwise hold a subrequest far longer than a healthy fetch ever does. */
  signal?: AbortSignal;
  timeoutMs?: number;
};

/**
 * Issue one Lodgify call through the configured egress.
 *
 * `path` is an absolute API path (`/v1/reservation?...`), never a full URL — the
 * origin is the gateway's business, not the call site's.
 */
export async function lodgifyFetch(path: string, opts: LodgifyFetchOpts): Promise<Response> {
  if (!path.startsWith("/")) {
    throw new Error(`lodgifyFetch expects an absolute path, got ${JSON.stringify(path.slice(0, 80))}`);
  }
  if (!isAllowedLodgifyPath(path)) {
    throw new Error(
      `Lodgify path not in the relay allowlist: ${path.split("?")[0]}. Add it to `
      + `LODGIFY_ALLOWED_PATH_PREFIXES and to the relay config, in that order.`,
    );
  }

  const headers: Record<string, string> = {
    "X-ApiKey": opts.apiKey,
    "Accept": "application/json",
    "User-Agent": LODGIFY_USER_AGENT,
    ...(opts.headers ?? {}),
  };
  if (opts.gateway.relayed && opts.gateway.key) {
    headers[GATEWAY_KEY_HEADER] = opts.gateway.key;
  }

  return fetch(`${opts.gateway.base}${path}`, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body != null ? { body: opts.body } : {}),
    signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
}

/**
 * True when the RELAY failed, not Lodgify. Callers must not treat this as a
 * Lodgify rate limit and retry it four times — a down relay or a rejected
 * secret will not heal within the retry window, and on a listing path a
 * swallowed failure renders as "this account has no bookings".
 */
export function isGatewayFailure(res: Response): boolean {
  return res.headers.get(GATEWAY_ERROR_HEADER) != null;
}

/**
 * One-line description of the egress for logs and incident copy. Safe to print:
 * carries the host, never the secret.
 */
export function describeLodgifyEgress(gateway: LodgifyGateway): string {
  return gateway.relayed ? `relay ${gateway.base}` : "direct (no fixed IP)";
}
