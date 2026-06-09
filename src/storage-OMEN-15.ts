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
  // 0 or 1. When 1, qualifying cross-border EU B2B orders bypass OSS VAT and
  // are invoiced as reverse charge. Requires vat_included = 1 to avoid mismatch
  // between amount paid and invoice total.
  b2b_reverse_charge: number | null;
  // PT exemption code stamped on reverse-charge invoices. Default M16.
  ix_b2b_exemption_reason: string | null;
  // 0 or 1. When 1, every issued invoice carries the `retention` field with
  // ix_retention as the percentage. Stored separately from the value so the
  // last picked rate survives toggling off.
  ix_retention_enabled: number | null;
  // PT IRS/IRC withholding percentage, 0–99.99. NULL when never set.
  ix_retention: number | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface PendingReverseChargeRow {
  id: string;
  shopify_domain: string | null;
  user_id: string | null;
  order_id: string;
  vat_id: string;
  country_code: string;
  normalized_json: string;
  webhook_topic: string;
  webhook_id: string | null;
  attempts: number;
  status: "pending" | "approved" | "rejected" | "resolved";
  next_retry_at: string;
  last_error: string | null;
  incident_id: string | null;
  created_at: string;
  updated_at: string;
}

export type SourceKind = "shopify" | "stripe";
export type DestinationKind = "invoicexpress" | "moloni";

export interface ConnectionRow {
  id: string;
  user_id: string;
  source_kind: SourceKind;
  destination_kind: DestinationKind;
  source_config_json: string | null;
  destination_config_json: string | null;
  behavior_json: string | null;
  status: "draft" | "active" | "paused" | "error";
  created_at: string;
  updated_at: string;
}

export class AppStorage {
  private db: D1Database;
  private kv: KVNamespace;
  private shopDomain: string | null;
  private userId: string | null;

  constructor(env: Env, shopDomain?: string | null, userId?: string | null) {
    this.db = env.DB;
    this.kv = env.INVOICE_KV;
    this.shopDomain = shopDomain ?? null;
    this.userId = userId ?? null;
  }

  async loadConfig(): Promise<IRequestConfig | null> {
    const shopHeader = this.shopDomain;
    console.log(`[AppConfig] accessing shopify domain: ${shopHeader}`)

    if (!shopHeader) {
      // Stripe-only users don't have a shopify_domain. If the AppStorage was
      // constructed with a userId, fall back to user-keyed lookup so the
      // pipeline (and Dev Mode worker endpoints) still get a config row.
      if (this.userId) return this.loadConfigByUser(this.userId);
      return null;
    }

    const integration = await this.db.prepare(
      "SELECT * FROM integrations WHERE shopify_domain = ?"
    ).bind(shopHeader).first();

    if (!integration) return null;

    // Memoize the user_id on this instance so subsequent writes (webhook_info,
    // logs, dev_jobs) populate it without each caller threading user_id through.
    if (!this.userId) this.userId = (integration as any).user_id ?? null;

    return integration as unknown as IRequestConfig;
  }

  async loadConfigByUser(userId: string): Promise<IRequestConfig | null> {
    const integration = await this.db.prepare(
      "SELECT * FROM integrations WHERE user_id = ?"
    ).bind(userId).first();
    if (!integration) return null;
    if (!this.userId) this.userId = userId;
    if (!this.shopDomain) this.shopDomain = (integration as any).shopify_domain ?? null;
    return integration as unknown as IRequestConfig;
  }

  async saveLog(data: { shopify_domain: string | null; topic: string; payload: any; response: any; status: number; user_id?: string | null }) {
    try {
      await this.db.prepare(
        "INSERT INTO logs (id, shopify_domain, user_id, topic, payload, response, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        crypto.randomUUID(),
        data.shopify_domain,
        data.user_id ?? this.userId,
        data.topic,
        JSON.stringify(data.payload),
        JSON.stringify(data.response),
        data.status
      ).run();
    } catch (e) {
      console.error("[Rioko] Failed to save log:", e);
    }
  }

  async isInvoiceAlreadyProcessed(orderId: string, sourceKind?: SourceKind) {
    const newKey = `${sourceKind ?? "shopify"}_order:${orderId}`;
    const legacyKey = `shopify_order:${orderId}`;

    // 1. Primary Check: Durable D1 (SQL) for strict consistency. The D1 row is
    //    keyed only by `id`, so source_kind is irrelevant here.
    try {
      const row: any = await this.db.prepare("SELECT invoice_id FROM processed_orders WHERE id = ?").bind(String(orderId)).first();
      if (row && row.invoice_id) {
        return true;
      };
    } catch (e) {
      console.error("[Rioko] Idempotency check failed in D1, falling back to KV:", e);
    }

    // 2. Secondary Check: Fast KV. Try new namespaced key first, fall back to
    //    legacy "shopify_order:" key for rows written before Phase 3.
    const fresh = await this.kv.get(newKey);
    if (fresh) return true;
    if (newKey !== legacyKey) {
      const legacy = await this.kv.get(legacyKey);
      if (legacy) return true;
    }
    return false;
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

  async saveProcessedInvoice(orderId: string, invoiceId: string, opts?: { sourceKind?: SourceKind; destinationKind?: DestinationKind }) {
    const sourceKind = opts?.sourceKind ?? "shopify";
    const destinationKind = opts?.destinationKind ?? "invoicexpress";
    const key = `${sourceKind}_order:${orderId}`;

    // 1. Record in D1 (Atomic/Strict). source_kind/destination_kind columns
    //    added in migration 0007 are nullable; we now populate them on new
    //    writes. Legacy rows with NULL are read as ("shopify","invoicexpress").
    try {
      await this.db.prepare(
        "INSERT INTO processed_orders (id, invoice_id, shopify_domain, user_id, created_at, source_kind, destination_kind) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        String(orderId),
        String(invoiceId),
        this.shopDomain,
        this.userId,
        new Date().toISOString(),
        sourceKind,
        destinationKind,
      ).run();
    } catch (e) {
      console.warn("[Rioko] Failed to save processed invoice in D1:", e);
    }

    // 2. Record in KV (Fast/Eventually Consistent). Key namespaced by source.
    try {
      await this.kv.put(key, String(invoiceId));
    } catch (e) {
      console.warn("[Rioko] Failed to save processed invoice in KV:", e);
    }
  }

  async deleteProcessedInvoice(orderId: string, sourceKind?: SourceKind) {
    const newKey = `${sourceKind ?? "shopify"}_order:${orderId}`;
    const legacyKey = `shopify_order:${orderId}`;
    try {
      await this.db.prepare("DELETE FROM processed_orders WHERE id = ?").bind(String(orderId)).run();
    } catch (e) {
      console.warn("[Rioko] Failed to delete processed invoice in D1:", e);
    }
    try {
      await this.kv.delete(newKey);
      if (newKey !== legacyKey) await this.kv.delete(legacyKey);
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

  async getLastProcessedDateByUser(userId: string, sourceKind?: SourceKind): Promise<string | null> {
    try {
      const sql = sourceKind
        ? "SELECT MAX(created_at) as last FROM processed_orders WHERE user_id = ? AND source_kind = ?"
        : "SELECT MAX(created_at) as last FROM processed_orders WHERE user_id = ?";
      const stmt = sourceKind
        ? this.db.prepare(sql).bind(userId, sourceKind)
        : this.db.prepare(sql).bind(userId);
      const row: any = await stmt.first();
      return row?.last ?? null;
    } catch (e) {
      console.error("[Rioko] Failed to get last processed date by user:", e);
      return null;
    }
  }

  async listProcessedInvoices(limit = 500, order: "asc" | "desc" = "desc"): Promise<Array<{ id: string; invoice_id: string; created_at: string | null }>> {
    try {
      const sql = `SELECT id, invoice_id, created_at FROM processed_orders WHERE shopify_domain = ? ORDER BY rowid ${order === "asc" ? "ASC" : "DESC"} LIMIT ?`;
      const result = await this.db.prepare(sql).bind(this.shopDomain, limit).all();
      return (result.results as any[]).map(r => ({ id: String(r.id), invoice_id: String(r.invoice_id), created_at: r.created_at ?? null }));
    } catch (e) {
      console.error("[Rioko] Failed to list processed invoices:", e);
      return [];
    }
  }

  async listProcessedInvoicesByUser(userId: string, sourceKind: SourceKind | undefined, limit = 500, order: "asc" | "desc" = "desc"): Promise<Array<{ id: string; invoice_id: string; created_at: string | null; source_kind: string | null }>> {
    try {
      const orderClause = order === "asc" ? "ASC" : "DESC";
      const sql = sourceKind
        ? `SELECT id, invoice_id, created_at, source_kind FROM processed_orders WHERE user_id = ? AND source_kind = ? ORDER BY rowid ${orderClause} LIMIT ?`
        : `SELECT id, invoice_id, created_at, source_kind FROM processed_orders WHERE user_id = ? ORDER BY rowid ${orderClause} LIMIT ?`;
      const stmt = sourceKind
        ? this.db.prepare(sql).bind(userId, sourceKind, limit)
        : this.db.prepare(sql).bind(userId, limit);
      const result = await stmt.all();
      return (result.results as any[]).map(r => ({ id: String(r.id), invoice_id: String(r.invoice_id), created_at: r.created_at ?? null, source_kind: r.source_kind ?? null }));
    } catch (e) {
      console.error("[Rioko] Failed to list processed invoices by user:", e);
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
        "INSERT INTO dev_jobs (id, shopify_domain, user_id, type, params, status, triggered_by, reason, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)"
      ).bind(
        params.id,
        this.shopDomain,
        this.userId,
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

  async getDevJobsByUser(userId: string, limit = 50): Promise<any[]> {
    try {
      const result = await this.db.prepare(
        "SELECT id, type, status, summary, triggered_by, reason, started_at, finished_at FROM dev_jobs WHERE user_id = ? ORDER BY started_at DESC LIMIT ?"
      ).bind(userId, limit).all();
      return (result.results as any[]).map(r => ({
        ...r,
        summary: r.summary ? JSON.parse(r.summary) : null,
      }));
    } catch (e) {
      console.error("[Rioko] Failed to get dev jobs by user:", e);
      return [];
    }
  }

  async getDevJob(id: string): Promise<any | null> {
    try {
      // Allow lookup by id alone when the AppStorage has neither shopify_domain
      // nor user_id set; the row's own scoping is verified by the caller.
      const sql = this.shopDomain
        ? "SELECT * FROM dev_jobs WHERE id = ? AND shopify_domain = ?"
        : this.userId
          ? "SELECT * FROM dev_jobs WHERE id = ? AND user_id = ?"
          : "SELECT * FROM dev_jobs WHERE id = ?";
      const stmt = this.shopDomain
        ? this.db.prepare(sql).bind(id, this.shopDomain)
        : this.userId
          ? this.db.prepare(sql).bind(id, this.userId)
          : this.db.prepare(sql).bind(id);
      const row: any = await stmt.first();
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

  async getLogsByUser(userId: string, limit = 100, statusFilter?: "errors" | "all"): Promise<any[]> {
    try {
      const where = statusFilter === "errors"
        ? "WHERE user_id = ? AND status >= 400"
        : "WHERE user_id = ?";
      const result = await this.db.prepare(
        `SELECT id, topic, payload, response, status FROM logs ${where} ORDER BY rowid DESC LIMIT ?`
      ).bind(userId, limit).all();
      return result.results as any[];
    } catch (e) {
      console.error("[Rioko] Failed to get logs by user:", e);
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

  async getWebhookEventsByUser(userId: string, limit = 100): Promise<any[]> {
    try {
      const result = await this.db.prepare(
        "SELECT webhook_id, topic, state, created_at FROM webhook_info WHERE user_id = ? ORDER BY created_at DESC LIMIT ?"
      ).bind(userId, limit).all();
      return result.results as any[];
    } catch (e) {
      console.error("[Rioko] Failed to get webhook events by user:", e);
      return [];
    }
  }

  // Resolves the user_id this AppStorage targets. Prefers an explicit constructor
  // userId, falls back to a lookup by shopify_domain so legacy callers that only
  // pass the shop still work.
  private async resolveUserId(): Promise<string | null> {
    if (this.userId) return this.userId;
    if (!this.shopDomain) return null;
    try {
      const row: any = await this.db.prepare(
        "SELECT user_id FROM integrations WHERE shopify_domain = ?"
      ).bind(this.shopDomain).first();
      return row?.user_id ?? null;
    } catch {
      return null;
    }
  }

  async getNotifyEmails(): Promise<string[]> {
    const userId = await this.resolveUserId();
    if (!userId) return [];
    try {
      const row: any = await this.db.prepare(
        "SELECT dev_notify_emails FROM integrations WHERE user_id = ?"
      ).bind(userId).first();
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
    const userId = await this.resolveUserId();
    if (!userId) return;
    await this.db.prepare(
      "UPDATE integrations SET dev_notify_emails = ? WHERE user_id = ?"
    ).bind(JSON.stringify(emails), userId).run();
  }

  async getTaxOverride(): Promise<{
    force_tax_rate: number | null;
    force_shipping_tax_rate: number | null;
    oss_enabled: number;
    b2b_reverse_charge: number;
    ix_b2b_exemption_reason: string;
  }> {
    const userId = await this.resolveUserId();
    try {
      const row: any = userId
        ? await this.db.prepare(
            "SELECT force_tax_rate, force_shipping_tax_rate, oss_enabled, b2b_reverse_charge, ix_b2b_exemption_reason FROM integrations WHERE user_id = ?"
          ).bind(userId).first()
        : null;
      return {
        force_tax_rate: row?.force_tax_rate ?? null,
        force_shipping_tax_rate: row?.force_shipping_tax_rate ?? null,
        oss_enabled: row?.oss_enabled ?? 1,
        b2b_reverse_charge: row?.b2b_reverse_charge ?? 0,
        ix_b2b_exemption_reason: row?.ix_b2b_exemption_reason ?? "M16",
      };
    } catch (e) {
      console.error("[Rioko] Failed to get tax override:", e);
      return {
        force_tax_rate: null,
        force_shipping_tax_rate: null,
        oss_enabled: 1,
        b2b_reverse_charge: 0,
        ix_b2b_exemption_reason: "M16",
      };
    }
  }

  async setTaxOverride(
    force_tax_rate: number | null,
    force_shipping_tax_rate: number | null,
    oss_enabled: boolean,
    b2b_reverse_charge: boolean = false,
    ix_b2b_exemption_reason: string = "M16",
  ) {
    const userId = await this.resolveUserId();
    if (!userId) return;
    await this.db.prepare(
      "UPDATE integrations SET force_tax_rate = ?, force_shipping_tax_rate = ?, oss_enabled = ?, b2b_reverse_charge = ?, ix_b2b_exemption_reason = ? WHERE user_id = ?"
    ).bind(
      force_tax_rate,
      force_shipping_tax_rate,
      oss_enabled ? 1 : 0,
      b2b_reverse_charge ? 1 : 0,
      ix_b2b_exemption_reason || "M16",
      userId,
    ).run();
  }

  async enqueuePendingReverseCharge(input: {
    shopify_domain: string | null;
    user_id: string;
    order_id: string;
    vat_id: string;
    country_code: string;
    normalized_json: string;
    webhook_topic: string;
    webhook_id: string | null;
    next_retry_at: string;
    last_error?: string | null;
  }): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      // Uniqueness pivoted from (shopify_domain, order_id) to (user_id, order_id)
      // in migration 0012 so Stripe rows (no shopify_domain) still dedup per
      // merchant.
      await this.db.prepare(
        `INSERT INTO pending_reverse_charge
          (id, shopify_domain, user_id, order_id, vat_id, country_code, normalized_json, webhook_topic, webhook_id, attempts, status, next_retry_at, last_error, incident_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?, NULL, ?, ?)
         ON CONFLICT(user_id, order_id) DO UPDATE SET
           vat_id = excluded.vat_id,
           country_code = excluded.country_code,
           normalized_json = excluded.normalized_json,
           webhook_topic = excluded.webhook_topic,
           webhook_id = excluded.webhook_id,
           attempts = pending_reverse_charge.attempts + 1,
           next_retry_at = excluded.next_retry_at,
           last_error = excluded.last_error,
           status = CASE WHEN pending_reverse_charge.status IN ('approved','rejected','resolved') THEN pending_reverse_charge.status ELSE 'pending' END,
           updated_at = excluded.updated_at`
      ).bind(
        id,
        input.shopify_domain,
        input.user_id,
        String(input.order_id),
        input.vat_id,
        input.country_code,
        input.normalized_json,
        input.webhook_topic,
        input.webhook_id,
        input.next_retry_at,
        input.last_error ?? null,
        now,
        now,
      ).run();
    } catch (e) {
      console.error("[Rioko] enqueuePendingReverseCharge failed:", e);
    }
    return id;
  }

  async getPendingForRetry(limit = 50): Promise<PendingReverseChargeRow[]> {
    const nowIso = new Date().toISOString();
    try {
      const result = await this.db.prepare(
        "SELECT * FROM pending_reverse_charge WHERE status = 'pending' AND attempts < 3 AND next_retry_at <= ? ORDER BY next_retry_at ASC LIMIT ?"
      ).bind(nowIso, limit).all();
      return (result.results as unknown as PendingReverseChargeRow[]) ?? [];
    } catch (e) {
      console.error("[Rioko] getPendingForRetry failed:", e);
      return [];
    }
  }

  async getPendingNeedingIncident(limit = 50): Promise<PendingReverseChargeRow[]> {
    try {
      const result = await this.db.prepare(
        "SELECT * FROM pending_reverse_charge WHERE status = 'pending' AND attempts >= 3 AND incident_id IS NULL LIMIT ?"
      ).bind(limit).all();
      return (result.results as unknown as PendingReverseChargeRow[]) ?? [];
    } catch (e) {
      console.error("[Rioko] getPendingNeedingIncident failed:", e);
      return [];
    }
  }

  async markPendingAttempt(id: string, attempts: number, nextRetryAt: string, lastError: string | null) {
    const now = new Date().toISOString();
    try {
      await this.db.prepare(
        "UPDATE pending_reverse_charge SET attempts = ?, next_retry_at = ?, last_error = ?, updated_at = ? WHERE id = ?"
      ).bind(attempts, nextRetryAt, lastError, now, id).run();
    } catch (e) {
      console.error("[Rioko] markPendingAttempt failed:", e);
    }
  }

  async attachPendingIncident(id: string, incidentBucketKey: string) {
    const now = new Date().toISOString();
    try {
      await this.db.prepare(
        "UPDATE pending_reverse_charge SET incident_id = ?, updated_at = ? WHERE id = ?"
      ).bind(incidentBucketKey, now, id).run();
    } catch (e) {
      console.error("[Rioko] attachPendingIncident failed:", e);
    }
  }

  async resolvePending(id: string, status: "approved" | "rejected" | "resolved") {
    const now = new Date().toISOString();
    try {
      await this.db.prepare(
        "UPDATE pending_reverse_charge SET status = ?, updated_at = ? WHERE id = ?"
      ).bind(status, now, id).run();
    } catch (e) {
      console.error("[Rioko] resolvePending failed:", e);
    }
  }

  async getPendingById(id: string): Promise<PendingReverseChargeRow | null> {
    try {
      const row = await this.db.prepare(
        "SELECT * FROM pending_reverse_charge WHERE id = ?"
      ).bind(id).first();
      return (row as unknown as PendingReverseChargeRow) ?? null;
    } catch (e) {
      console.error("[Rioko] getPendingById failed:", e);
      return null;
    }
  }

  async getPendingByOrderId(shopDomain: string, orderId: string): Promise<PendingReverseChargeRow | null> {
    try {
      const row = await this.db.prepare(
        "SELECT * FROM pending_reverse_charge WHERE shopify_domain = ? AND order_id = ?"
      ).bind(shopDomain, String(orderId)).first();
      return (row as unknown as PendingReverseChargeRow) ?? null;
    } catch (e) {
      console.error("[Rioko] getPendingByOrderId failed:", e);
      return null;
    }
  }

  async getPendingByUserOrder(userId: string, orderId: string): Promise<PendingReverseChargeRow | null> {
    try {
      const row = await this.db.prepare(
        "SELECT * FROM pending_reverse_charge WHERE user_id = ? AND order_id = ?"
      ).bind(userId, String(orderId)).first();
      return (row as unknown as PendingReverseChargeRow) ?? null;
    } catch (e) {
      console.error("[Rioko] getPendingByUserOrder failed:", e);
      return null;
    }
  }

  async listPendingByUser(userId: string, status: "pending" | "all" = "pending", limit = 100): Promise<PendingReverseChargeRow[]> {
    try {
      const sql = status === "all"
        ? "SELECT * FROM pending_reverse_charge WHERE user_id = ? ORDER BY created_at DESC LIMIT ?"
        : "SELECT * FROM pending_reverse_charge WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT ?";
      const result = await this.db.prepare(sql).bind(userId, limit).all();
      return (result.results as unknown as PendingReverseChargeRow[]) ?? [];
    } catch (e) {
      console.error("[Rioko] listPendingByUser failed:", e);
      return [];
    }
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
      await this.db.prepare("INSERT OR REPLACE INTO webhook_info (webhook_id, topic, state, created_at, shopify_domain, user_id) VALUES (?, ?, ?, ?, ?, ?)").bind(
        webhookId,
        topic,
        "processing",
        new Date().toISOString(),
        this.shopDomain,
        this.userId,
      ).run();
    } catch (e) {
      console.warn("[Rioko] Failed to mark webhook as processing:", e);
    }
  }

  async markWebhookAsProcessed(webhookId: string, topic: string, state: string = "success") {
    try {
      await this.db.prepare("INSERT OR REPLACE INTO webhook_info (webhook_id, topic, state, created_at, shopify_domain, user_id) VALUES (?, ?, ?, ?, ?, ?)").bind(
        webhookId,
        topic,
        state,
        new Date().toISOString(),
        this.shopDomain,
        this.userId,
      ).run();
    } catch (e) {
      console.warn("[Rioko] Failed to mark webhook as processed:", e);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 2: connections lookup. Not yet wired into runtime handlers — Phase 3+
  // will switch the pipeline to read from these before falling back to the
  // legacy `integrations` row.
  // ──────────────────────────────────────────────────────────────────────────

  async loadConnectionsByUser(userId: string): Promise<ConnectionRow[]> {
    const rows = await this.db.prepare(
      "SELECT * FROM connections WHERE user_id = ? ORDER BY created_at ASC"
    ).bind(userId).all();
    return (rows.results as unknown as ConnectionRow[]) ?? [];
  }

  async getActiveConnection(
    userId: string,
    sourceKind: SourceKind,
    destinationKind: DestinationKind
  ): Promise<ConnectionRow | null> {
    const row = await this.db.prepare(
      "SELECT * FROM connections WHERE user_id = ? AND source_kind = ? AND destination_kind = ? AND status = 'active' LIMIT 1"
    ).bind(userId, sourceKind, destinationKind).first();
    return (row as unknown as ConnectionRow) ?? null;
  }

  async upsertConnection(input: {
    id?: string;
    user_id: string;
    source_kind: SourceKind;
    destination_kind: DestinationKind;
    source_config_json?: string | null;
    destination_config_json?: string | null;
    behavior_json?: string | null;
    status?: "draft" | "active" | "paused" | "error";
  }): Promise<ConnectionRow> {
    const id = input.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const status = input.status ?? "draft";

    await this.db.prepare(
      `INSERT INTO connections
        (id, user_id, source_kind, destination_kind, source_config_json, destination_config_json, behavior_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, source_kind, destination_kind) DO UPDATE SET
         source_config_json = excluded.source_config_json,
         destination_config_json = excluded.destination_config_json,
         behavior_json = excluded.behavior_json,
         status = excluded.status,
         updated_at = excluded.updated_at`
    ).bind(
      id,
      input.user_id,
      input.source_kind,
      input.destination_kind,
      input.source_config_json ?? null,
      input.destination_config_json ?? null,
      input.behavior_json ?? null,
      status,
      now,
      now,
    ).run();

    const row = await this.db.prepare(
      "SELECT * FROM connections WHERE user_id = ? AND source_kind = ? AND destination_kind = ?"
    ).bind(input.user_id, input.source_kind, input.destination_kind).first();
    return row as unknown as ConnectionRow;
  }
}
