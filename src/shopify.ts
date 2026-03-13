import type { Context } from "hono";
import type { Env } from "./env";
import type { IRequestConfig } from "./storage";
import type { NormalizedOrderResponse } from "./api/normalize-shopify";
import { cloneRawRequest } from "hono/request";

export class Shopify {
  private ctx: Context<{ Bindings: Env }>;
  private config: IRequestConfig;

  constructor(ctx: Context<{ Bindings: Env }>, config: IRequestConfig) {
    this.ctx = ctx;
    this.config = config;
  }

  public async verifyWebhook(secret?: string): Promise<boolean> {
    const hmac = this.ctx.req.header("X-Shopify-Hmac-Sha256");
    if (!hmac) return false;

    const body = await (await cloneRawRequest(this.ctx.req)).text();
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret ?? this.config.shopify_webhook_secret!),
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

  public async normalizeOrder(orderId: string): Promise<NormalizedOrderResponse | null> {
    const authResponse = await fetch(`https://endpoint-shopify.srv1250352.hstgr.cloud/orders/normalize/${orderId}`, {
      headers: {
        "x-api-key": this.ctx.env.NORMALIZE_SHOPIFY_ORDER_API_KEY.trim(),

        "shop-url": this.config.shopify_domain!,
        "access-token": this.config.shopify_token!,
        "Accept": "application/json"
      },
    });

    if (!authResponse.ok) {
      console.error(`[Rioko] Failed to normalize order ${orderId}:`, await authResponse.text());
      console.error({
        "x-api-key": this.ctx.env.NORMALIZE_SHOPIFY_ORDER_API_KEY.trim(),

        "shop-url": this.config.shopify_domain!,
        "access-token": this.config.shopify_token!,
        "Accept": "application/json"
      });
      return null;
    }

    return authResponse.json();
  }
}
