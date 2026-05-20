import type { SourceAdapter, AdapterCtx } from "../types";
import type { Normalized } from "../../api/normalize-shopify";
import { Shopify, verifyShopifyWebhook } from "../../shopify";

export class ShopifySource implements SourceAdapter {
  readonly kind = "shopify" as const;

  async verifyWebhook(rawBody: string, signature: string, secret: string): Promise<boolean> {
    return verifyShopifyWebhook(signature, rawBody, secret);
  }

  externalId(parsedBody: any): string {
    return String(parsedBody?.id ?? "");
  }

  async toNormalized(parsedBody: any, ctx: AdapterCtx): Promise<Normalized | null> {
    const shopify = new Shopify(ctx.apiKey, ctx.config);
    const response = await shopify.normalizeOrder(String(parsedBody.id));
    return response?.normalized ?? null;
  }
}
