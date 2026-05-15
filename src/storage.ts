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
  // Dev Mode tax overrides
  force_tax_rate: number | null;
  force_shipping_tax_rate: number | null;
  oss_enabled: number | null;
  created_at: string | null;
  updated_at: string | null;
}

export class AppStorage {
  private db: D1Database;
  private kv: KVNamespace;
  private shopDomain: string | null;

  constructor(env: Env, shopDomain?: string) {
    this.db = env.DB;
    this.kv = env.INVOICE_KV;
    this.shopDomain = shopDomain ?? null;
  }

  async loadConfig(): Promise<IRequestConfig | null> {
    const shopHeader = this.shopDomain;
    console.log(`[AppConfig] accessing shopify domain: ${shopHeader}`)

    if (!shopHeader) return null;

    const integration = await this.db.prepare(
      "SELECT * FROM integrations WHERE shopify_domain = ?"
    ).bind(shopHeader).first();

    if (!integration) return null;

    return integration as unknown as IRequestConfig;
  }

  async saveLog(data: { shopify_domain: string | null; topic: string; payload: any; response: any; status: number }) {
    try {
      await this.db.prepare(
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
      const row: any = await this.db.prepare("SELECT invoice_id FROM processed_orders WHERE id = ?").bind(String(orderId)).first();
      if (row && row.invoice_id) {
        return true;
      };
    } catch (e) {
      console.error("[Rioko] Idempotency check failed in D1, falling back to KV:", e);
    }

    // 2. Secondary Check: Fast KV (Eventually Consistent)
    const row = await this.kv.get(key);
    return !!row;
  }

  async getInvoiceByOrderId(orderId: string): Promise<{ id: string; invoice_id: string } | null> {
    try {
      const row: any = await this.db.prepare("SELECT id, invoice_id FROM processed_orders WHERE id = ?").bind(String(orderId)).first();
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
      await this.db.prepare("INSERT INTO processed_orders (id, invoice_id, shopify_domain, created_at) VALUES (?, ?, ?, ?)")
        .bind(String(orderId), String(invoiceId), this.shopDomain, new Date().toISOString()).run();
    } catch (e) {
      console.warn("[Rioko] Failed to save processed invoice in D1:", e);
    }

    // 2. Record in KV (Fast/Eventually Consistent)
    try {
      await this.kv.put(key, String(invoiceId));
    } catch (e) {
      console.warn("[Rioko] Failed to save processed invoice in KV:", e);
    }
  }

  async deleteProcessedInvoice(orderId: string) {
    const key = `shopify_order:${orderId}`;
    try {
      await this.db.prepare("DELETE FROM processed_orders WHERE id = ?").bind(String(orderId)).run();
    } catch (e) {
      console.warn("[Rioko] Failed to delete processed invoice in D1:", e);
    }
    try {
      await this.kv.delete(key);
    } catch (e) {
      console.warn("[Rioko] Failed to delete processed invoice in KV:", e);
    }
  }

  async getLastProcessedDate(): Promise<string | null> {
    try {
      const row: any = await this.db.prepare(
        "SELECT MAX(created_at) as last FROM processed_orders WHERE shopify_domain = ?"
      ).bind(this.shopDomain).first();
      return row?.last ?? null;
    } catch (e) {
      console.error("[Rioko] Failed to get last processed date:", e);
      return null;
    }
  }

  async listProcessedInvoices(limit = 500): Promise<Array<{ id: string; invoice_id: string; created_at: string | null }>> {
    try {
      const result = await this.db.prepare(
        "SELECT id, invoice_id, created_at FROM processed_orders WHERE shopify_domain = ? ORDER BY rowid DESC LIMIT ?"
      ).bind(this.shopDomain, limit).all();
      return (result.results as any[]).map(r => ({ id: String(r.id), invoice_id: String(r.invoice_id), created_at: r.created_at ?? null }));
    } catch (e) {
      console.error("[Rioko] Failed to list processed invoices:", e);
      return [];
    }
  }

  async startDevJob(params: {
    id: string;
    type: string;
    params: any;
    triggered_by?: string | null;
    reason?: string | null;
  }) {
    try {
      await this.db.prepare(
        "INSERT INTO dev_jobs (id, shopify_domain, type, params, status, triggered_by, reason, started_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)"
      ).bind(
        params.id,
        this.shopDomain,
        params.type,
        JSON.stringify(params.params),
        params.triggered_by ?? null,
        params.reason ?? null,
        new Date().toISOString()
      ).run();
    } catch (e) {
      console.warn("[Rioko] Failed to start dev job:", e);
    }
  }

  async finishDevJob(id: string, status: "success" | "partial" | "error", summary: any, results: any) {
    try {
      await this.db.prepare(
        "UPDATE dev_jobs SET status = ?, summary = ?, results = ?, finished_at = ? WHERE id = ?"
      ).bind(status, JSON.stringify(summary), JSON.stringify(results), new Date().toISOString(), id).run();
    } catch (e) {
      console.warn("[Rioko] Failed to finish dev job:", e);
    }
  }

  async getDevJobs(limit = 50): Promise<any[]> {
    try {
      const result = await this.db.prepare(
        "SELECT id, type, status, summary, triggered_by, reason, started_at, finished_at FROM dev_jobs WHERE shopify_domain = ? ORDER BY started_at DESC LIMIT ?"
      ).bind(this.shopDomain, limit).all();
      return (result.results as any[]).map(r => ({
        ...r,
        summary: r.summary ? JSON.parse(r.summary) : null,
      }));
    } catch (e) {
      console.error("[Rioko] Failed to get dev jobs:", e);
      return [];
    }
  }

  async getDevJob(id: string): Promise<any | null> {
    try {
      const row: any = await this.db.prepare(
        "SELECT * FROM dev_jobs WHERE id = ? AND shopify_domain = ?"
      ).bind(id, this.shopDomain).first();
      if (!row) return null;
      return {
        ...row,
        params: row.params ? JSON.parse(row.params) : null,
        summary: row.summary ? JSON.parse(row.summary) : null,
        results: row.results ? JSON.parse(row.results) : null,
      };
    } catch (e) {
      console.error("[Rioko] Failed to get dev job:", e);
      return null;
    }
  }

  async getLogs(limit = 100, statusFilter?: "errors" | "all"): Promise<any[]> {
    try {
      const where = statusFilter === "errors"
        ? "WHERE shopify_domain = ? AND status >= 400"
        : "WHERE shopify_domain = ?";
      const result = await this.db.prepare(
        `SELECT id, topic, payload, response, status FROM logs ${where} ORDER BY rowid DESC LIMIT ?`
      ).bind(this.shopDomain, limit).all();
      return result.results as any[];
    } catch (e) {
      console.error("[Rioko] Failed to get logs:", e);
      return [];
    }
  }

  async getWebhookEvents(limit = 100): Promise<any[]> {
    try {
      const result = await this.db.prepare(
        "SELECT webhook_id, topic, state, created_at FROM webhook_info WHERE shopify_domain = ? OR shopify_domain IS NULL ORDER BY created_at DESC LIMIT ?"
      ).bind(this.shopDomain, limit).all();
      return result.results as any[];
    } catch (e) {
      console.error("[Rioko] Failed to get webhook events:", e);
      return [];
    }
  }

  async getNotifyEmails(): Promise<string[]> {
    try {
      const row: any = await this.db.prepare(
        "SELECT dev_notify_emails FROM integrations WHERE shopify_domain = ?"
      ).bind(this.shopDomain).first();
      if (!row?.dev_notify_emails) return [];
      try {
        const parsed = JSON.parse(row.dev_notify_emails);
        return Array.isArray(parsed) ? parsed.filter((e: any) => typeof e === "string") : [];
      } catch {
        return [];
      }
    } catch (e) {
      console.error("[Rioko] Failed to get notify emails:", e);
      return [];
    }
  }

  async setNotifyEmails(emails: string[]) {
    await this.db.prepare(
      "UPDATE integrations SET dev_notify_emails = ? WHERE shopify_domain = ?"
    ).bind(JSON.stringify(emails), this.shopDomain).run();
  }

  async getTaxOverride(): Promise<{ force_tax_rate: number | null; force_shipping_tax_rate: number | null; oss_enabled: number }> {
    try {
      const row: any = await this.db.prepare(
        "SELECT force_tax_rate, force_shipping_tax_rate, oss_enabled FROM integrations WHERE shopify_domain = ?"
      ).bind(this.shopDomain).first();
      return {
        force_tax_rate: row?.force_tax_rate ?? null,
        force_shipping_tax_rate: row?.force_shipping_tax_rate ?? null,
        oss_enabled: row?.oss_enabled ?? 1,
      };
    } catch (e) {
      console.error("[Rioko] Failed to get tax override:", e);
      return { force_tax_rate: null, force_shipping_tax_rate: null, oss_enabled: 1 };
    }
  }

  async setTaxOverride(force_tax_rate: number | null, force_shipping_tax_rate: number | null, oss_enabled: boolean) {
    await this.db.prepare(
      "UPDATE integrations SET force_tax_rate = ?, force_shipping_tax_rate = ?, oss_enabled = ? WHERE shopify_domain = ?"
    ).bind(force_tax_rate, force_shipping_tax_rate, oss_enabled ? 1 : 0, this.shopDomain).run();
  }

  async getReconciliationOverrides(orderIds: string[]): Promise<{
    matches: Map<string, { invoice_id: string; approved_by: string | null; approved_at: string }>;
    decisions: Map<string, { decision: string; reason: string | null; decided_by: string | null; decided_at: string }>;
  }> {
    const matches = new Map();
    const decisions = new Map();
    if (orderIds.length === 0) return { matches, decisions };

    for (let i = 0; i < orderIds.length; i += 50) {
      const chunk = orderIds.slice(i, i + 50);
      const placeholders = chunk.map(() => "?").join(",");
      try {
        const mRes = await this.db.prepare(
          `SELECT order_id, invoice_id, approved_by, approved_at FROM reconciliation_match WHERE shopify_domain = ? AND order_id IN (${placeholders})`
        ).bind(this.shopDomain, ...chunk).all();
        for (const r of mRes.results as any[]) {
          matches.set(String(r.order_id), { invoice_id: String(r.invoice_id), approved_by: r.approved_by ?? null, approved_at: r.approved_at });
        }
        const dRes = await this.db.prepare(
          `SELECT order_id, decision, reason, decided_by, decided_at FROM reconciliation_decision WHERE shopify_domain = ? AND order_id IN (${placeholders})`
        ).bind(this.shopDomain, ...chunk).all();
        for (const r of dRes.results as any[]) {
          decisions.set(String(r.order_id), { decision: r.decision, reason: r.reason ?? null, decided_by: r.decided_by ?? null, decided_at: r.decided_at });
        }
      } catch (e) {
        console.error("[Rioko] reconciliation overrides chunk failed:", e);
      }
    }
    return { matches, decisions };
  }

  async upsertReconciliationMatch(orderId: string, invoiceId: string, approvedBy: string | null) {
    await this.db.prepare(
      `INSERT INTO reconciliation_match (shopify_domain, order_id, invoice_id, approved_by, approved_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(shopify_domain, order_id) DO UPDATE SET invoice_id=excluded.invoice_id, approved_by=excluded.approved_by, approved_at=excluded.approved_at`
    ).bind(this.shopDomain, String(orderId), String(invoiceId), approvedBy, new Date().toISOString()).run();
  }

  async deleteReconciliationMatch(orderId: string) {
    await this.db.prepare(
      "DELETE FROM reconciliation_match WHERE shopify_domain = ? AND order_id = ?"
    ).bind(this.shopDomain, String(orderId)).run();
  }

  async setReconciliationDecision(orderId: string, decision: string, reason: string | null, decidedBy: string | null) {
    await this.db.prepare(
      `INSERT INTO reconciliation_decision (shopify_domain, order_id, decision, reason, decided_by, decided_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(shopify_domain, order_id) DO UPDATE SET decision=excluded.decision, reason=excluded.reason, decided_by=excluded.decided_by, decided_at=excluded.decided_at`
    ).bind(this.shopDomain, String(orderId), decision, reason, decidedBy, new Date().toISOString()).run();
  }

  async clearReconciliationDecision(orderId: string) {
    await this.db.prepare(
      "DELETE FROM reconciliation_decision WHERE shopify_domain = ? AND order_id = ?"
    ).bind(this.shopDomain, String(orderId)).run();
  }

  async getShopByUserId(userId: string): Promise<string | null> {
    try {
      const row: any = await this.db.prepare(
        "SELECT shopify_domain FROM integrations WHERE user_id = ?"
      ).bind(userId).first();
      return row?.shopify_domain ?? null;
    } catch (e) {
      console.error("[Rioko] getShopByUserId failed:", e);
      return null;
    }
  }

  async getProcessedInvoicesByOrderIds(orderIds: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (orderIds.length === 0) return map;
    for (let i = 0; i < orderIds.length; i += 50) {
      const chunk = orderIds.slice(i, i + 50);
      const placeholders = chunk.map(() => "?").join(",");
      try {
        const result = await this.db.prepare(
          `SELECT id, invoice_id FROM processed_orders WHERE id IN (${placeholders})`
        ).bind(...chunk).all();
        for (const row of result.results as any[]) {
          if (row.invoice_id) map.set(String(row.id), String(row.invoice_id));
        }
      } catch (e) {
        console.error("[Rioko] getProcessedInvoicesByOrderIds chunk failed:", e);
      }
    }
    return map;
  }

  async getProcessedOrderIds(orderIds: string[]): Promise<Set<string>> {
    const processed = new Set<string>();
    // Batch in chunks of 50 to avoid SQL parameter limits
    for (let i = 0; i < orderIds.length; i += 50) {
      const chunk = orderIds.slice(i, i + 50);
      const placeholders = chunk.map(() => '?').join(',');
      const result = await this.db.prepare(
        `SELECT id FROM processed_orders WHERE id IN (${placeholders})`
      ).bind(...chunk).all();
      for (const row of result.results) {
        processed.add(String((row as any).id));
      }
    }
    return processed;
  }

  async isWebhookProcessed(webhookId: string, topic: string): Promise<{ isProcessed: boolean; state?: string }> {
    try {
      const row: any = await this.db.prepare("SELECT webhook_id, state FROM webhook_info WHERE webhook_id = ? AND topic = ?").bind(webhookId, topic).first();

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
      await this.db.prepare("INSERT OR REPLACE INTO webhook_info (webhook_id, topic, state, created_at, shopify_domain) VALUES (?, ?, ?, ?, ?)").bind(
        webhookId,
        topic,
        "processing",
        new Date().toISOString(),
        this.shopDomain
      ).run();
    } catch (e) {
      console.warn("[Rioko] Failed to mark webhook as processing:", e);
    }
  }

  async markWebhookAsProcessed(webhookId: string, topic: string, state: string = "success") {
    try {
      await this.db.prepare("INSERT OR REPLACE INTO webhook_info (webhook_id, topic, state, created_at, shopify_domain) VALUES (?, ?, ?, ?, ?)").bind(
        webhookId,
        topic,
        state,
        new Date().toISOString(),
        this.shopDomain
      ).run();
    } catch (e) {
      console.warn("[Rioko] Failed to mark webhook as processed:", e);
    }
  }
}
