import type { IRequestConfig } from "./storage";
import type { NormalizedOrderResponse } from "./api/normalize-shopify";
import { buildNormalizedFromRaw } from "./ix/normalize-local";
import { delay } from "./utils";

export async function verifyShopifyWebhook(hmac: string, body: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const signature = new Uint8Array(
    atob(hmac)
      .split("")
      .map((c) => c.charCodeAt(0))
  );

  return await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    encoder.encode(body)
  );
}

export class Shopify {
  private apiKey: string;
  private config: IRequestConfig;

  constructor(apiKey: string, config: IRequestConfig) {
    this.apiKey = apiKey;
    this.config = config;
  }

  public async normalizeOrder(orderId: string): Promise<NormalizedOrderResponse | null> {
    const [normalized, rawOrder] = await Promise.all([
      this.fetchNormalized(orderId),
      this.fetchRawOrder(orderId).catch((e) => {
        console.warn(`[Rioko] raw shopify fetch failed for ${orderId}, proceeding without discount enrichment:`, e);
        return null;
      }),
    ]);
    if (!normalized) return null;
    if (rawOrder) {
      enrichWithDiscountAllocations(normalized, rawOrder);
      normalized.raw_order = rawOrder;
      if (normalized.normalized) normalized.normalized.raw_order = rawOrder;
    }
    return normalized;
  }

  // In-worker normalization for the Shopify→IX CREATE path — no external
  // Hostinger call. Fetches the raw order directly from Shopify (the same fetch
  // `normalizeOrder` already does in parallel) and maps it into the Normalized
  // shape the builder's raw path consumes. Gated by NORMALIZE_IN_WORKER at the
  // handler call site; validated byte-identical to the Hostinger path by
  // scripts/shadow-normalize.mjs before cutover.
  public async normalizeOrderLocal(orderId: string): Promise<NormalizedOrderResponse | null> {
    const raw = await this.fetchRawOrder(orderId).catch((e) => {
      console.error(`[Rioko] raw shopify fetch failed for ${orderId} (local normalize):`, e);
      return null;
    });
    if (!raw) return null; // transient → caller throws → queue retries (same as remote)
    return buildNormalizedFromRaw(raw, this.config.shopify_domain ?? "");
  }

  private async fetchNormalized(orderId: string): Promise<NormalizedOrderResponse | null> {
    const url = `https://endpoint-shopify.srv1250352.hstgr.cloud/orders/normalize/${orderId}`;
    const headers = {
      "x-api-key": this.apiKey.trim(),
      "shop-url": this.config.shopify_domain!,
      "access-token": this.config.shopify_token!,
      "Accept": "application/json",
    };

    // The normalize service is an external single point of failure. Add a bounded
    // timeout + short retries so a transient blip doesn't burn the queue's retry
    // budget. A definitive "order not found" (the Shopify order was deleted) is
    // PERMANENT — throw a recognizable error so classifyPipelineError acks it once
    // instead of retrying ~25× pointlessly.
    const MAX_ATTEMPTS = 3;
    let lastErr = "";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      } catch (e: any) {
        lastErr = `network/timeout: ${e?.message ?? e}`;
        if (attempt < MAX_ATTEMPTS) { await delay(400 * attempt); continue; }
        return null; // transient → caller throws "Failed to normalize" → queue retries
      }

      if (res.ok) return res.json();

      const bodyText = await res.text().catch(() => "");
      // Order gone in Shopify — the service returns 404, or 5xx whose body says
      // "Unable to fetch order" / "Shopify error 404". Never recoverable.
      if (res.status === 404 || /unable to fetch order|shopify error 404/i.test(bodyText)) {
        throw new Error(`Normalize: order ${orderId} not found in Shopify (permanent): ${bodyText.slice(0, 160)}`);
      }

      lastErr = `http ${res.status}: ${bodyText.slice(0, 160)}`;
      if (attempt < MAX_ATTEMPTS && res.status >= 500) { await delay(400 * attempt); continue; }
      break; // 4xx (other than 404) — don't hammer
    }
    console.error(`[Rioko] Failed to normalize order ${orderId} after ${MAX_ATTEMPTS} attempts: ${lastErr}`);
    return null;
  }

  private async fetchRawOrder(orderId: string): Promise<any | null> {
    const apiVersion = this.config.shopify_api_version ?? "2026-01";
    const url = `https://${this.config.shopify_domain}/admin/api/${apiVersion}/orders/${orderId}.json`;
    const res = await fetch(url, {
      headers: { "X-Shopify-Access-Token": this.config.shopify_token!, "Accept": "application/json" },
    });
    if (!res.ok) throw new Error(`Shopify ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { order?: any };
    return data.order ?? null;
  }
}

function enrichWithDiscountAllocations(normalized: NormalizedOrderResponse, rawOrder: any): void {
  const allocationsById = new Map<number, number>();
  const collect = (lines: any[] | undefined) => {
    if (!Array.isArray(lines)) return;
    for (const line of lines) {
      const allocations = line?.discount_allocations;
      if (!Array.isArray(allocations) || allocations.length === 0) continue;
      const sum = allocations.reduce((acc: number, a: any) => acc + Number(a?.amount ?? 0), 0);
      if (sum > 0 && line?.id != null) {
        allocationsById.set(Number(line.id), Math.round(sum * 100) / 100);
      }
    }
  };
  collect(rawOrder?.line_items);
  collect(rawOrder?.shipping_lines);
  if (allocationsById.size === 0) return;

  const items = normalized?.normalized?.order?.items;
  if (!Array.isArray(items)) return;

  const shippingLines = Array.isArray(rawOrder?.shipping_lines) ? rawOrder.shipping_lines : [];
  const lonelyShippingAllocation = shippingLines.length === 1
    ? allocationsById.get(Number(shippingLines[0].id)) ?? 0
    : 0;

  for (const item of items) {
    const byId = item?.id != null ? allocationsById.get(Number(item.id)) : undefined;
    if (byId != null && byId > 0) {
      item.discount_allocation_amount = byId;
      continue;
    }
    if (!item.product_id && !item.variant_id && lonelyShippingAllocation > 0) {
      item.discount_allocation_amount = lonelyShippingAllocation;
    }
  }
}
