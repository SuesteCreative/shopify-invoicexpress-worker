import type { IRequestConfig } from "../storage";

/**
 * Reading orders out of the Shopify Admin REST API.
 *
 * Lived inside src/handlers/admin.ts, which made it unreachable from anything
 * that was not the legacy Shopify dev-mode handler — including the generic
 * recovery engine, whose whole job is to ask a source "what did you sell in this
 * window?" without knowing which source it is talking to.
 */

const DEFAULT_API_VERSION = "2026-01";

function shopifyHeaders(config: IRequestConfig) {
  return {
    "X-Shopify-Access-Token": config.shopify_token!,
    "Accept": "application/json",
  };
}

/**
 * Every order processed in a window, following the Link-header pagination.
 *
 * `status=any` on purpose: a cancelled or archived order still has to be visible
 * to reconciliation, which is comparing against what we invoiced, not against
 * what is still open.
 */
export async function fetchShopifyOrders(config: IRequestConfig, from: string, to: string): Promise<any[]> {
  const allOrders: any[] = [];
  const apiVersion = config.shopify_api_version ?? DEFAULT_API_VERSION;
  let url: string | null =
    `https://${config.shopify_domain}/admin/api/${apiVersion}/orders.json`
    + `?processed_at_min=${encodeURIComponent(from)}&processed_at_max=${encodeURIComponent(to)}&status=any&limit=250`;

  while (url) {
    const response = await fetch(url, { headers: shopifyHeaders(config) });
    if (!response.ok) {
      throw new Error(`Shopify API error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as { orders: any[] };
    allOrders.push(...data.orders);

    const linkHeader = response.headers.get("Link");
    url = null;
    if (linkHeader) {
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (nextMatch) url = nextMatch[1];
    }
  }

  return allOrders;
}

/** Batch lookup by order id. One call; Shopify caps the set at 250. */
export async function fetchOrdersByIds(config: IRequestConfig, orderIds: number[]): Promise<any[]> {
  if (orderIds.length === 0) return [];
  const apiVersion = config.shopify_api_version ?? DEFAULT_API_VERSION;
  const url = `https://${config.shopify_domain}/admin/api/${apiVersion}/orders.json`
    + `?ids=${orderIds.join(",")}&status=any&limit=250`;

  const response = await fetch(url, { headers: shopifyHeaders(config) });
  if (!response.ok) {
    throw new Error(`Shopify API error: ${response.status} ${await response.text()}`);
  }
  const data = await response.json() as { orders: any[] };
  return data.orders;
}

/**
 * One order by the number a human reads off the storefront ("#1137").
 *
 * Returns null when Shopify has no such order — which, for a store that plainly
 * does have it, almost always means a missing `read_all_orders` scope rather
 * than a missing order. See `shopifyOrderNotFoundHint`.
 */
export async function fetchShopifyOrderByNumber(config: IRequestConfig, orderNumber: number | string): Promise<any | null> {
  const apiVersion = config.shopify_api_version ?? DEFAULT_API_VERSION;
  const url = `https://${config.shopify_domain}/admin/api/${apiVersion}/orders.json`
    + `?name=${encodeURIComponent("#" + orderNumber)}&status=any&limit=1`;

  const res = await fetch(url, { headers: shopifyHeaders(config) });
  if (!res.ok) throw new Error(`Shopify ${res.status}: ${await res.text()}`);
  const data = await res.json() as { orders: any[] };
  return data.orders?.[0] ?? null;
}

/**
 * The single most useful diagnostic in the Shopify recovery path, kept in one
 * place so every caller says the same thing: without `read_all_orders` the Admin
 * API silently hides orders older than 60 days, so "not found" reads as "the
 * order does not exist" when it means "your token cannot see it".
 */
export function shopifyOrderNotFoundHint(orderNumber: number | string): string {
  return `Order #${orderNumber} not found in Shopify. If the order exists in the store, the access token is likely missing the read_all_orders scope (Shopify's Admin API only returns the last 60 days of orders without it). Add read_all_orders to the Custom App configuration, regenerate the token, and retry.`;
}
