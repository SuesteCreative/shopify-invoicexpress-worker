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
    const authResponse = await fetch(`https://endpoint-shopify.srv1250352.hstgr.cloud/orders/normalize/${orderId}`, {
      headers: {
        "x-api-key": this.apiKey.trim(),

        "shop-url": this.config.shopify_domain!,
        "access-token": this.config.shopify_token!,
        "Accept": "application/json"
      },
    });

    if (!authResponse.ok) {
      console.error(`[Rioko] Failed to normalize order ${orderId}:`, await authResponse.text());
      console.error({
        "x-api-key": this.apiKey.trim(),

        "shop-url": this.config.shopify_domain!,
        "access-token": this.config.shopify_token!,
        "Accept": "application/json"
      });
      return null;
    }

    return authResponse.json();
  }
}
