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
  // 0 or 1. When 1 (default for all shops), hold invoice emission until Shopify
  // confirms payment (financial_status = "paid"). Pending/authorized orders
  // (e.g. Multibanco) are not invoiced at orders/created; orders/paid emits them
  // on payment. Orthogonal to auto_finalize. Set to 0 to restore emit-at-create.
  only_invoice_when_paid: number | null;
  // 0 or 1. When 1, invoices/credit notes whose exemption code is applied (any
  // 0%-tax line, non reverse-charge) also carry the bilingual legal mention for
  // that code in `observations` (see src/ix/exemption-mentions.ts). Off by
  // default; enabled per shop that needs the exemption spelled out for carriers
  // /customs (e.g. UPS on US exports). Derived from ix_exemption_reason.
  ix_stamp_exemption_note: number | null;
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
  // 0 or 1. When 1, every webhook handler short-circuits before reaching
  // the destination — no IX/Moloni documents are generated. Independent of
  // shopify_authorized / webhooks_active so the user can pause without
  // tearing down the integration.
  is_paused: number | null;
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

export type SourceKind = "shopify" | "stripe" | "eupago" | "lodgify";
export type DestinationKind = "invoicexpress" | "moloni" | "vendus";

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
      // Stripe-only users have no shopify_domain. If this AppStorage was
      // constructed with a userId, fall back to the user-keyed lookup so the
      // pipeline (and Dev Mode worker endpoints) still resolve a config row.
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
        "INSERT OR REPLACE INTO processed_orders (id, invoice_id, shopify_domain, user_id, created_at, source_kind, destination_kind) VALUES (?, ?, ?, ?, ?, ?, ?)"
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

  // Reconciliation invoice-meta cache (KV). The conciliação view used to re-fetch
  // every invoice's metadata from the IX proxy on EVERY load — a 200-order shop
  // hammered ix-proxy.kapta.app with 200 reads per refresh, which is the root
  // cause of the "phantom Sem fatura" (proxy overload → null metas). We cache the
  // immutable-ish meta (reference/total/date/permalink) keyed by invoice id so
  // subsequent loads read from KV instead. 24h TTL: ref/total/date never change;
  // only `status` can drift (draft→final), which is harmless for a matching view.
  // ns namespaces the cache per destination so a Moloni document id can't collide
  // with an InvoiceXpress invoice id of the same number. Defaults to "ixmeta" to
  // keep the already-warm Shopify→IX cache valid.
  async getCachedInvoiceMetas(invoiceIds: string[], ns: string = "ixmeta"): Promise<Map<string, any>> {
    const map = new Map<string, any>();
    await Promise.all(invoiceIds.map(async (id) => {
      try {
        const v = await this.kv.get(`${ns}:${id}`);
        if (v) map.set(String(id), JSON.parse(v));
      } catch { /* treat as cache miss */ }
    }));
    return map;
  }

  async cacheInvoiceMeta(invoiceId: string, meta: any, ns: string = "ixmeta"): Promise<void> {
    try {
      await this.kv.put(`${ns}:${invoiceId}`, JSON.stringify(meta), { expirationTtl: 86400 });
    } catch { /* best-effort cache; a miss just refetches */ }
  }

  // Reference-lookup cache (KV). Conciliação asks IX whether a document with our
  // "Order #N" reference exists for orders with no DB mapping (recovers manual or
  // mapping-lost invoices). The IX reference search is expensive, so we cache the
  // result per (account, reference) — an invoice id when found, the sentinel
  // "MISS" when not — for 1h, so repeated loads don't re-hammer the proxy. Short
  // TTL because a current MISS can become a hit once the invoice is created.
  async getCachedRefLookups(account: string, refs: string[], ns: string = "ixref"): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    await Promise.all(refs.map(async (ref) => {
      try {
        const v = await this.kv.get(`${ns}:${account}:${ref}`);
        if (v) map.set(ref, v);
      } catch { /* treat as cache miss */ }
    }));
    return map;
  }

  async cacheRefLookup(account: string, ref: string, value: string, ns: string = "ixref"): Promise<void> {
    try {
      await this.kv.put(`${ns}:${account}:${ref}`, value, { expirationTtl: 3600 });
    } catch { /* best-effort */ }
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

  // Stripe-only equivalent of getLastProcessedDate — those rows have no
  // shopify_domain, so they're keyed by user_id instead.
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

  // Stripe-only equivalent of listProcessedInvoices, keyed by user_id.
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

  // Stripe-only equivalent of getDevJobs, keyed by user_id.
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
      // Stripe-only callers have no shopDomain — fall back to user_id scoping,
      // or bare id lookup when neither is set on this instance.
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

  // Stripe-only equivalent of getLogs, keyed by user_id.
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

  // Stripe-only equivalent of getWebhookEvents, keyed by user_id.
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

  async getTaxOverride(): Promise<{
    force_tax_rate: number | null;
    force_shipping_tax_rate: number | null;
    oss_enabled: number;
    b2b_reverse_charge: number;
    ix_b2b_exemption_reason: string;
  }> {
    try {
      const row: any = await this.db.prepare(
        "SELECT force_tax_rate, force_shipping_tax_rate, oss_enabled, b2b_reverse_charge, ix_b2b_exemption_reason FROM integrations WHERE shopify_domain = ?"
      ).bind(this.shopDomain).first();
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
    await this.db.prepare(
      "UPDATE integrations SET force_tax_rate = ?, force_shipping_tax_rate = ?, oss_enabled = ?, b2b_reverse_charge = ?, ix_b2b_exemption_reason = ? WHERE shopify_domain = ?"
    ).bind(
      force_tax_rate,
      force_shipping_tax_rate,
      oss_enabled ? 1 : 0,
      b2b_reverse_charge ? 1 : 0,
      ix_b2b_exemption_reason || "M16",
      this.shopDomain,
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

  // Stripe-only equivalent of getPendingByOrderId — those rows have no
  // shopify_domain, so the dedup key is (user_id, order_id) per migration 0012.
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

  // sourceKind scopes the lookup so a Lodgify booking id can't collide with a
  // Shopify order id for a user who has both. Legacy rows predate the
  // source_kind column (NULL) and are Shopify, so a "shopify" filter must also
  // match NULL. Omit sourceKind to keep the old bare-id behaviour.
  async getProcessedInvoicesByOrderIds(orderIds: string[], sourceKind?: SourceKind): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (orderIds.length === 0) return map;
    for (let i = 0; i < orderIds.length; i += 50) {
      const chunk = orderIds.slice(i, i + 50);
      const placeholders = chunk.map(() => "?").join(",");
      try {
        const sql = sourceKind
          ? `SELECT id, invoice_id FROM processed_orders WHERE id IN (${placeholders}) AND (source_kind = ? OR (source_kind IS NULL AND ? = 'shopify'))`
          : `SELECT id, invoice_id FROM processed_orders WHERE id IN (${placeholders})`;
        const binds = sourceKind ? [...chunk, sourceKind, sourceKind] : chunk;
        const result = await this.db.prepare(sql).bind(...binds).all();
        for (const row of result.results as any[]) {
          if (row.invoice_id) map.set(String(row.id), String(row.invoice_id));
        }
      } catch (e) {
        console.error("[Rioko] getProcessedInvoicesByOrderIds chunk failed:", e);
      }
    }
    return map;
  }

  /** Bulk-upsert Lodgify bookings into the local mirror (`lodgify_bookings`),
   *  synced by the 30-min poll. Reconciliation reads from this table instead of
   *  hitting the rate-limited Lodgify API on every page load. Keyed by booking
   *  id; stores the full v2 item as raw_json plus queryable columns. */
  async upsertLodgifyBookings(userId: string, bookings: any[]): Promise<number> {
    if (!Array.isArray(bookings) || bookings.length === 0) return 0;
    const num = (v: unknown): number | null => {
      const n = typeof v === "object" && v !== null && "amount" in (v as any) ? Number((v as any).amount) : Number(v as any);
      return Number.isFinite(n) ? n : null;
    };
    const ymd = (v: unknown): string | null => {
      const m = String(v ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
      return m ? m[1] : null;
    };
    const stmt = this.db.prepare(
      `INSERT INTO lodgify_bookings
         (id, user_id, status, amount_due, amount_paid, total_amount, currency_code,
          arrival, departure, created_at, updated_at, source, property_id,
          guest_name, guest_email, raw_json, synced_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET
         user_id=excluded.user_id, status=excluded.status, amount_due=excluded.amount_due,
         amount_paid=excluded.amount_paid, total_amount=excluded.total_amount,
         currency_code=excluded.currency_code, arrival=excluded.arrival, departure=excluded.departure,
         created_at=excluded.created_at, updated_at=excluded.updated_at, source=excluded.source,
         property_id=excluded.property_id, guest_name=excluded.guest_name,
         guest_email=excluded.guest_email, raw_json=excluded.raw_json, synced_at=CURRENT_TIMESTAMP`
    );
    const rows: any[] = [];
    for (const b of bookings) {
      const id = String(b?.id ?? b?.booking_id ?? b?.reservation_id ?? "");
      if (!id) continue;
      rows.push(stmt.bind(
        id, userId, b?.status ?? null, num(b?.amount_due), num(b?.amount_paid),
        num(b?.total_amount), b?.currency_code ?? null, ymd(b?.arrival), ymd(b?.departure),
        b?.created_at ?? null, b?.updated_at ?? null, b?.source ?? null,
        b?.property_id != null ? String(b.property_id) : null,
        b?.guest?.name ?? null, b?.guest?.email ?? null, JSON.stringify(b),
      ));
    }
    if (rows.length === 0) return 0;
    // Chunk to stay under D1's per-batch statement cap.
    for (let i = 0; i < rows.length; i += 50) {
      await this.db.batch(rows.slice(i, i + 50));
    }
    return rows.length;
  }

  /** Instalment invoices already issued for a booking (progressive invoicing). */
  async getPartialInvoices(userId: string, bookingId: string): Promise<Array<{ seq: number; invoice_id: string | null; invoiced_amount: number; our_reference: string | null }>> {
    try {
      const res = await this.db.prepare(
        "SELECT seq, invoice_id, invoiced_amount, our_reference FROM lodgify_partial_invoices WHERE user_id = ? AND booking_id = ? ORDER BY seq"
      ).bind(userId, String(bookingId)).all();
      return ((res.results ?? []) as any[]).map((r) => ({
        seq: Number(r.seq),
        invoice_id: r.invoice_id ? String(r.invoice_id) : null,
        invoiced_amount: Number(r.invoiced_amount ?? 0),
        our_reference: r.our_reference ?? null,
      }));
    } catch (e) { console.error("[Rioko] getPartialInvoices failed:", e); return []; }
  }

  async upsertPartialInvoice(userId: string, bookingId: string, seq: number, invoiceId: string, invoicedAmount: number, ourReference: string): Promise<void> {
    await this.db.prepare(
      `INSERT INTO lodgify_partial_invoices (booking_id, user_id, seq, invoice_id, invoiced_amount, our_reference, created_at)
       VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(booking_id, seq) DO UPDATE SET
         invoice_id=excluded.invoice_id, invoiced_amount=excluded.invoiced_amount, our_reference=excluded.our_reference`
    ).bind(String(bookingId), userId, seq, String(invoiceId), invoicedAmount, ourReference).run();
  }

  /** For reconciliation: booking_id → [invoice_id, …] across all instalments. */
  async getPartialInvoicesByBookingIds(userId: string, bookingIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (!userId || bookingIds.length === 0) return map;
    for (let i = 0; i < bookingIds.length; i += 50) {
      const chunk = bookingIds.slice(i, i + 50);
      const ph = chunk.map(() => "?").join(",");
      try {
        const res = await this.db.prepare(
          `SELECT booking_id, invoice_id FROM lodgify_partial_invoices WHERE user_id = ? AND booking_id IN (${ph}) AND invoice_id IS NOT NULL ORDER BY seq`
        ).bind(userId, ...chunk).all();
        for (const r of (res.results ?? []) as any[]) {
          const b = String(r.booking_id);
          if (!map.has(b)) map.set(b, []);
          map.get(b)!.push(String(r.invoice_id));
        }
      } catch (e) { console.error("[Rioko] getPartialInvoicesByBookingIds chunk failed:", e); }
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
      const row: any = await this.db.prepare(
        "SELECT webhook_id, state, created_at FROM webhook_info WHERE webhook_id = ? AND topic = ?"
      ).bind(webhookId, topic).first();

      if (!row) {
        return { isProcessed: false };
      }

      // Allow retry if failed.
      if (row.state === "failed") {
        return { isProcessed: false, state: "failed" };
      }

      // Defensive net: a row stuck in `processing` for more than 10 minutes
      // means the queue consumer died before marking it. Treat as retryable
      // so a Shopify HTTP redelivery (or admin re-emit) doesn't get dropped.
      if (row.state === "processing") {
        const created = Date.parse(row.created_at);
        if (!isNaN(created) && Date.now() - created > 10 * 60_000) {
          return { isProcessed: false, state: "stale" };
        }
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

  /** Drop dedup state so an admin replay isn't short-circuited. */
  async resetWebhookInfo(webhookId: string, topic: string) {
    try {
      await this.db.prepare("DELETE FROM webhook_info WHERE webhook_id = ? AND topic = ?").bind(webhookId, topic).run();
    } catch (e) {
      console.warn("[Rioko] Failed to reset webhook_info:", e);
    }
    try {
      await this.db.prepare("DELETE FROM processed_orders WHERE id = ?").bind(String(webhookId)).run();
    } catch (e) {
      console.warn("[Rioko] Failed to reset processed_orders:", e);
    }
    try {
      await this.kv.delete(`lodgify_order:${webhookId}`);
      await this.kv.delete(`shopify_order:${webhookId}`);
    } catch (e) {
      console.warn("[Rioko] Failed to reset KV dedup keys:", e);
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
