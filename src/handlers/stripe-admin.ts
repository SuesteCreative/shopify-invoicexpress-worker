import type { Env } from "../env";
import type { DestinationKind } from "../adapters/types";
import { resolveStripeAuth, type StripeAuth } from "../services/stripe-auth";

/**
 * Stripe webhook + event recovery helpers (Phase 3 ops tooling).
 *
 * All calls use the per-connection `restricted_key` stored in
 * `connections.source_config_json` — the same key captured at webhook install
 * time (scope: webhook_endpoints + events:read). Drives the backoffice dev-mode
 * cards for: inspecting endpoint status, re-enabling a Stripe-disabled endpoint,
 * deleting an orphan endpoint, and replaying missed events back into the queue.
 */

const STRIPE_API = "https://api.stripe.com/v1";
const STRIPE_VERSION = "2024-12-18.acacia";

export interface StripeConnection {
  connectionId: string;
  /** Which of the two Stripe kinds this is — a replayed event must say. */
  sourceKind: "stripe" | "stripe_connect";
  /** Platform key + acct_… for Connect, the merchant's restricted key otherwise. */
  auth: StripeAuth;
  /**
   * The merchant's own restricted key, and only that.
   *
   * Null for Connect, on purpose: the webhook-endpoint tools below manage an
   * endpoint that lives on the MERCHANT's Stripe account, which is a thing only
   * the restricted-key integration has. Connect merchants are served by the
   * platform's own endpoint, so those tools have nothing to show them and say so
   * instead of pretending the connection does not exist.
   */
  restrictedKey: string | null;
  webhookEndpointId: string | null;
  sourceConfig: Record<string, any>;
  /** So a replayed event lands on the same destination the webhook would have. */
  destinationKind: DestinationKind | null;
}

/**
 * Load the Stripe-source connection these ops tools should act on.
 *
 * Both kinds, active first. Hardcoding `source_kind = 'stripe'` meant every one
 * of these tools answered 404 to a Stripe Connect merchant — including the event
 * replay, which is the tool you reach for when a merchant is missing documents.
 * Worse, the replay then enqueued the event with no `sourceKind`, and the queue
 * consumer defaults to `"stripe"`: a Connect merchant's replayed payment was
 * processed against the restricted-key connection, with its destination and its
 * series.
 *
 * The credential comes from `resolveStripeAuth`, which is where the difference
 * between the two kinds actually lives (`auth_mode`, not `source_kind`).
 *
 * A connection that can actually TALK to Stripe beats one that cannot, exactly
 * as in `loadStripeConnectionFull`. `LIMIT 1` plus "give up if that one has no
 * credential" is the same defect that function was fixed for, one file over: an
 * active `stripe` row whose restricted key was never saved (or was rotated away)
 * sorted first, failed `resolveStripeAuth`, and every tool here answered 404 to
 * a merchant whose Stripe Connect connection was perfectly healthy.
 *
 * `destinationKind` narrows when the caller names it, because `/admin/stripe/replay`
 * stamps this row's destination on the queue message: with two `stripe`
 * connections into different destinations, an unnarrowed pick invoices a
 * replayed payment into the wrong one.
 */
export async function resolveStripeConnection(
  env: Env,
  userId: string,
  destinationKind?: string | null,
): Promise<StripeConnection | null> {
  const res = await env.DB.prepare(
    `SELECT id, source_kind, source_config_json, destination_kind FROM connections
     WHERE user_id = ? AND source_kind IN ('stripe', 'stripe_connect')
       AND (? IS NULL OR destination_kind = ?)
     ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,
              CASE WHEN source_kind = 'stripe' THEN 0 ELSE 1 END,
              updated_at DESC`
  ).bind(userId, destinationKind ?? null, destinationKind ?? null).all();

  const rows = ((res.results as any[]) ?? []).map((row) => {
    let cfg: Record<string, any> = {};
    try { cfg = row.source_config_json ? JSON.parse(row.source_config_json) : {}; } catch { cfg = {}; }
    const sourceKind = row.source_kind === "stripe_connect" ? "stripe_connect" : "stripe";
    return {
      connectionId: row.id as string,
      sourceKind: sourceKind as "stripe" | "stripe_connect",
      auth: resolveStripeAuth(env, cfg),
      restrictedKey: sourceKind === "stripe" ? ((cfg.restricted_key as string) ?? null) : null,
      webhookEndpointId: cfg.webhook_endpoint_id ?? null,
      sourceConfig: cfg,
      destinationKind: (row.destination_kind as DestinationKind) ?? null,
    };
  });

  const chosen = rows.find((r) => r.auth);
  if (!chosen) return null;

  if (rows.length > 1) {
    console.warn(
      `[Stripe] ${userId} has ${rows.length} Stripe connections (${rows.map((r) => `${r.sourceKind}→${r.destinationKind}`).join(", ")}); ops tooling picked ${chosen.sourceKind}→${chosen.destinationKind}`,
    );
  }
  return { ...chosen, auth: chosen.auth! };
}

/**
 * `auth` rather than a bare key, because the two Stripe kinds differ only in how
 * they authenticate: a restricted key speaks for the merchant's account by
 * itself, a platform key needs `Stripe-Account` to say whose account it is
 * reading. Without that header a Connect replay reads the PLATFORM's events —
 * Rioko's own — and finds nothing belonging to the merchant.
 */
async function stripeFetch(auth: StripeAuth, path: string, init: RequestInit = {}): Promise<any> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${auth.apiKey}`);
  headers.set("Stripe-Version", STRIPE_VERSION);
  if (auth.connectAccount) headers.set("Stripe-Account", auth.connectAccount);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/x-www-form-urlencoded");

  const res = await fetch(`${STRIPE_API}${path}`, { ...init, headers });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || `Stripe ${res.status}`;
    throw new Error(`Stripe API ${res.status}: ${msg}`);
  }
  return body;
}

export interface WebhookEndpointInfo {
  id: string;
  url: string;
  status: string;       // "enabled" | "disabled"
  enabled_events: string[];
}

/**
 * The three endpoint tools take a bare restricted key, not a StripeAuth.
 *
 * That is the distinction, not an oversight: they manage a webhook endpoint on
 * the MERCHANT's own Stripe account, which only the restricted-key integration
 * has. A Connect merchant is served by the platform's single endpoint, so there
 * is nothing here to list, re-enable or delete for them.
 */
/** List all webhook endpoints on the account behind this restricted_key. */
export async function listWebhookEndpoints(restrictedKey: string): Promise<WebhookEndpointInfo[]> {
  const body = await stripeFetch({ apiKey: restrictedKey }, "/webhook_endpoints?limit=100");
  return (body.data ?? []).map((e: any) => ({
    id: e.id,
    url: e.url,
    status: e.status,
    enabled_events: e.enabled_events ?? [],
  }));
}

/** Re-enable a Stripe-disabled endpoint (status flips back to enabled). */
export async function reenableWebhookEndpoint(restrictedKey: string, endpointId: string): Promise<WebhookEndpointInfo> {
  const e = await stripeFetch({ apiKey: restrictedKey }, `/webhook_endpoints/${encodeURIComponent(endpointId)}`, {
    method: "POST",
    body: "disabled=false",
  });
  return { id: e.id, url: e.url, status: e.status, enabled_events: e.enabled_events ?? [] };
}

/** Delete a webhook endpoint (used to clean up orphan/incomplete installs). */
export async function deleteWebhookEndpoint(restrictedKey: string, endpointId: string): Promise<{ id: string; deleted: boolean }> {
  const e = await stripeFetch({ apiKey: restrictedKey }, `/webhook_endpoints/${encodeURIComponent(endpointId)}`, { method: "DELETE" });
  return { id: e.id, deleted: !!e.deleted };
}

/** Fetch a single Stripe event by id (evt_...). Works for both Stripe kinds. */
export async function getStripeEvent(auth: StripeAuth, eventId: string): Promise<any> {
  return stripeFetch(auth, `/events/${encodeURIComponent(eventId)}`);
}

/**
 * List recent Stripe events for backfilling a gap. `types` filters by event
 * type; `from`/`to` are unix-seconds. Returns up to `limit` (default 100).
 */
export async function listStripeEvents(
  auth: StripeAuth,
  opts: { types?: string[]; from?: number; to?: number; limit?: number } = {},
): Promise<any[]> {
  const params = new URLSearchParams();
  params.set("limit", String(opts.limit ?? 100));
  (opts.types ?? []).forEach((t, i) => params.set(`types[${i}]`, t));
  if (opts.from) params.set("created[gte]", String(opts.from));
  if (opts.to) params.set("created[lte]", String(opts.to));
  const body = await stripeFetch(auth, `/events?${params.toString()}`);
  return body.data ?? [];
}
