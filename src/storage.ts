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
  ix_send_email: number | null;
  ix_email_body: string | null;
  ix_email_subject: string | null;

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

  async getInvoiceByOrderId(orderId: string): Promise<{ id: string; invoice_id: string } | null> {
    try {
      const row: any = await this.ctx.env.DB.prepare("SELECT id, invoice_id FROM processed_orders WHERE id = ?").bind(String(orderId)).first();
      if (row && row.invoice_id) {
        return { id: row.id, invoice_id: row.invoice_id };
      }
      return null;
    } catch (e) {
      console.error("[Rioko] Failed to get invoice by order number:", e);
      return null;
    }
  }

  async saveProcessedInvoice(orderId: string, invoiceId: string) {
    const key = `shopify_order:${orderId}`;

    // 1. Record in D1 (Atomic/Strict)
    try {
      await this.ctx.env.DB.prepare("INSERT INTO processed_orders (id, invoice_id) VALUES (?, ?)").bind(String(orderId), String(invoiceId)).run();
    } catch (e) {
      console.warn("[Rioko] Failed to save processed invoice in D1:", e);
    }

    // 2. Record in KV (Fast/Eventually Consistent)
    try {
      await this.ctx.env.INVOICE_KV.put(key, String(invoiceId));
    } catch (e) {
      console.warn("[Rioko] Failed to save processed invoice in KV:", e);
    }
  }

  async isWebhookProcessed(webhookId: string, topic: string): Promise<{ isProcessed: boolean; state?: string }> {
    try {
      const row: any = await this.ctx.env.DB.prepare("SELECT webhook_id, state FROM webhook_info WHERE webhook_id = ? AND topic = ?").bind(webhookId, topic).first();

      if (!row) {
        return { isProcessed: false };
      }

      // Allow retry if failed, skip if processing or success
      if (row.state === "failed") {
        return { isProcessed: false, state: "failed" };
      }

      return { isProcessed: true, state: row.state };
    } catch (e) {
      console.error("[Rioko] Failed to check webhook processed status:", e);
      return { isProcessed: false };
    }
  }

  async markWebhookAsProcessing(webhookId: string, topic: string) {
    try {
      await this.ctx.env.DB.prepare("INSERT OR REPLACE INTO webhook_info (webhook_id, topic, state, created_at) VALUES (?, ?, ?, ?)").bind(
        webhookId,
        topic,
        "processing",
        new Date().toISOString()
      ).run();
    } catch (e) {
      console.warn("[Rioko] Failed to mark webhook as processing:", e);
    }
  }

  async markWebhookAsProcessed(webhookId: string, topic: string, state: string = "success") {
    try {
      await this.ctx.env.DB.prepare("INSERT OR REPLACE INTO webhook_info (webhook_id, topic, state, created_at) VALUES (?, ?, ?, ?)").bind(
        webhookId,
        topic,
        state,
        new Date().toISOString()
      ).run();
    } catch (e) {
      console.warn("[Rioko] Failed to mark webhook as processed:", e);
    }
  }
}
