export interface Env {
  INVOICE_KV: KVNamespace;
  DB: D1Database;
  NORMALIZE_SHOPIFY_ORDER_API_KEY: string;
  SHOPIFY_ORDERS_QUEUE: Queue;
  STRIPE_QUEUE: Queue;
  ADMIN_API_KEY: string;
  CRON_SECRET?: string;
  BACKOFFICE_URL?: string;
  // Phase 3 feature flags
  DESTINATION_VIA_ADAPTER?: string; // "0" | "1" — when "1", Shopify queue routes through adapter pipeline
  STRIPE_SOURCE_ENABLED?: string;   // "0" | "1" — when "0", /webhooks/stripe/* returns 404
  // Phase 3 Stripe-source secret (set via `wrangler secret put STRIPE_WEBHOOK_SECRET`)
  STRIPE_WEBHOOK_SECRET?: string;
  // Phase 4a.1 — Resend + Incidents
  RESEND_API_KEY?: string;                // when set, sendEmail uses Resend; otherwise falls back to MailChannels
  RESEND_FROM_EMAIL?: string;             // optional override; defaults to rioko-devmode@kapta.pt
  KAPTA_DEV_EMAILS?: string;              // comma-separated list of dev team recipients for critical incidents
  INCIDENT_DIGEST_ENABLED?: string;       // "0" | "1" — gates the daily digest path in scheduled()
  WEEKLY_MERCHANT_DIGEST_ENABLED?: string; // "0" | "1" — gates the Friday per-merchant "unprocessed invoices" digest
  // Phase 4b — AI incident triage (advisory only). Presence of the key enables the
  // feature; absence => no-op. Set via `wrangler secret put ANTHROPIC_API_KEY`.
  ANTHROPIC_API_KEY?: string;             // when set, critical alert emails get an AI diagnosis block
  ANTHROPIC_MODEL?: string;               // optional model override; defaults to claude-sonnet-4-6
  AI_TRIAGE_HOURLY_CAP?: string;          // soft per-hour cost ceiling for triage calls; defaults to "40"
  AI_PATTERN_REPORT_ENABLED?: string;     // "0" | "1" — gates the Friday cross-incident pattern report
}
