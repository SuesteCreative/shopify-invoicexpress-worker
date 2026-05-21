import type { IRequestConfig } from "./storage";
import type { NormalizedOrderResponse } from "./api/normalize-shopify";

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
    if (rawOrder) enrichWithDiscountAllocations(normalized, rawOrder);
    return normalized;
  }

  private async fetchNormalized(orderId: string): Promise<NormalizedOrderResponse | null> {
    const authResponse = await fetch(`https://endpoint-shopify.srv1250352.hstgr.cloud/orders/normalize/${orderId}`, {
      headers: {
        "x-api-key": this.apiKey.trim(),
        "shop-url": this.config.shopify_domain!,
        "access-token": this.config.shopify_token!,
        "Accept": "application/json",
      },
    });
    if (!authResponse.ok) {
      console.error(`[Rioko] Failed to normalize order ${orderId}:`, await authResponse.text());
      return null;
    }
    return authResponse.json();
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
