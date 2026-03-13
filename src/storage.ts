import { Context } from "hono";
import { Env } from "./env";

export interface IRequestConfig {
  id: string | null;
  user_id: string;
  shopify_domain: string | null;
  shopify_token: string | null;
  shopify_webhook_secret: string | null;
  // 0 or 1
  shopify_authorized: number | null;
  // default 2026-01
  shopify_api_version: string | null;
  shopify_error: string | null;
  shopify_forced_at: string | null;
  webhooks_forced_at: string | null;

  // 0 or 1
  client_sync: number | null;
  // 0 or 1
  ix_authorized: number | null;
  // 0 or 1
  ix_payment_term: number | null;
  ix_error: string | null;
  // deefault M01
  ix_exemption_reason: string | null;
  ix_sequence_name: string | null;
  ix_account_name: string | null;
  ix_api_key: string | null;
  ix_forced_at: string | null;
  ix_document_type: string | null;
  // default production
  ix_environment: "production" | "development" | null;

  // 0 or 1
  vat_included: number | null;
  // 0 or 1
  auto_finalize: number | null;
  // 0 or 1
  webhooks_active: number | null;
  // 0 or 1
  pos_mode: number | null;
  created_at: string | null;
  updated_at: string | null;
}

export class AppStorage {
  private ctx: Context<{ Bindings: Env }>;

  constructor(ctx: Context<{ Bindings: Env }>) {
    this.ctx = ctx;
  }

  async loadConfig(): Promise<IRequestConfig | null> {
    const shopHeader = this.ctx.req.header("X-Shopify-Shop-Domain");
    console.log(`[AppConfig] accessing shopify domain: ${shopHeader}`)

    if (!shopHeader) return null;

    const integration = await this.ctx.env.DB.prepare(
      "SELECT * FROM integrations WHERE shopify_domain = ?"
    ).bind(shopHeader).first();

    if (!integration) return null;

    return integration as unknown as IRequestConfig;
  }

  async saveLog(data: { shopify_domain: string | null; topic: string; payload: any; response: any; status: number }) {
    try {
      await this.ctx.env.DB.prepare(
        "INSERT INTO logs (id, shopify_domain, topic, payload, response, status) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(
        crypto.randomUUID(),
        data.shopify_domain,
        data.topic,
        JSON.stringify(data.payload),
        JSON.stringify(data.response),
        data.status
      ).run();
    } catch (e) {
      console.error("[Rioko] Failed to save log:", e);
    }
  }

  async isInvoiceAlreadyProcessed(orderId: string) {
    const key = `shopify_order:${orderId}`;

    // 1. Primary Check: Durable D1 (SQL) for strict consistency
    try {
      const row: any = await this.ctx.env.DB.prepare("SELECT invoice_id FROM processed_orders WHERE id = ?").bind(String(orderId)).first();
      if (row && row.invoice_id) {
        return true;
      };
    } catch (e) {
      console.error("[Rioko] Idempotency check failed in D1, falling back to KV:", e);
    }

    // 2. Secondary Check: Fast KV (Eventually Consistent)
    const row = await this.ctx.env.INVOICE_KV.get(key);
    return !!row;
  }
}
