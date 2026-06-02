import type { Env } from "../env";

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
  restrictedKey: string;
  webhookEndpointId: string | null;
  sourceConfig: Record<string, any>;
}

/** Load the active (or draft) Stripe-source connection + its restricted_key. */
export async function resolveStripeConnection(env: Env, userId: string): Promise<StripeConnection | null> {
  const row: any = await env.DB.prepare(
    `SELECT id, source_config_json FROM connections
     WHERE user_id = ? AND source_kind = 'stripe'
     ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END
     LIMIT 1`
  ).bind(userId).first();
  if (!row) return null;

  let cfg: Record<string, any> = {};
  try { cfg = row.source_config_json ? JSON.parse(row.source_config_json) : {}; } catch { cfg = {}; }
  const restrictedKey = cfg.restricted_key as string | undefined;
  if (!restrictedKey) return null;

  return {
    connectionId: row.id,
    restrictedKey,
    webhookEndpointId: cfg.webhook_endpoint_id ?? null,
    sourceConfig: cfg,
  };
}

async function stripeFetch(restrictedKey: string, path: string, init: RequestInit = {}): Promise<any> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${restrictedKey}`);
  headers.set("Stripe-Version", STRIPE_VERSION);
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

/** List all webhook endpoints on the account behind this restricted_key. */
export async function listWebhookEndpoints(restrictedKey: string): Promise<WebhookEndpointInfo[]> {
  const body = await stripeFetch(restrictedKey, "/webhook_endpoints?limit=100");
  return (body.data ?? []).map((e: any) => ({
    id: e.id,
    url: e.url,
    status: e.status,
    enabled_events: e.enabled_events ?? [],
  }));
}

/** Re-enable a Stripe-disabled endpoint (status flips back to enabled). */
export async function reenableWebhookEndpoint(restrictedKey: string, endpointId: string): Promise<WebhookEndpointInfo> {
  const e = await stripeFetch(restrictedKey, `/webhook_endpoints/${encodeURIComponent(endpointId)}`, {
    method: "POST",
    body: "disabled=false",
  });
  return { id: e.id, url: e.url, status: e.status, enabled_events: e.enabled_events ?? [] };
}

/** Delete a webhook endpoint (used to clean up orphan/incomplete installs). */
export async function deleteWebhookEndpoint(restrictedKey: string, endpointId: string): Promise<{ id: string; deleted: boolean }> {
  const e = await stripeFetch(restrictedKey, `/webhook_endpoints/${encodeURIComponent(endpointId)}`, { method: "DELETE" });
  return { id: e.id, deleted: !!e.deleted };
}

/** Fetch a single Stripe event by id (evt_...). */
export async function getStripeEvent(restrictedKey: string, eventId: string): Promise<any> {
  return stripeFetch(restrictedKey, `/events/${encodeURIComponent(eventId)}`);
}

/**
 * List recent Stripe events for backfilling a gap. `types` filters by event
 * type; `from`/`to` are unix-seconds. Returns up to `limit` (default 100).
 */
export async function listStripeEvents(
  restrictedKey: string,
  opts: { types?: string[]; from?: number; to?: number; limit?: number } = {},
): Promise<any[]> {
  const params = new URLSearchParams();
  params.set("limit", String(opts.limit ?? 100));
  (opts.types ?? []).forEach((t, i) => params.set(`types[${i}]`, t));
  if (opts.from) params.set("created[gte]", String(opts.from));
  if (opts.to) params.set("created[lte]", String(opts.to));
  const body = await stripeFetch(restrictedKey, `/events?${params.toString()}`);
  return body.data ?? [];
}
