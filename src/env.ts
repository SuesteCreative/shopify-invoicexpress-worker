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
  // Lodgify booking poller (30-min cron). Lodgify does not expose webhook
  // registration to user-level API keys, so bookings are polled instead.
  // On by default; set to "0" to kill the poll without redeploying crons.
  LODGIFY_POLL_ENABLED?: string;          // "0" disables; any other value (or unset) = enabled
  // Subscription renewal reminders (daily 08:00 cron). Emails the customer + ops
  // ~7 days before an ending (cancel_at_period_end=1) subscription lapses.
  // On by default; set to "0" to disable without redeploying crons.
  RENEWAL_REMINDER_ENABLED?: string;      // "0" disables; any other value (or unset) = enabled
  // Self-healing invoice reconciliation sweep (daily 04:00 cron). Re-emits any
  // paid Shopify order missing its InvoiceXpress invoice, via the double-guarded
  // reemit path (no duplicates, drift-guarded). Ships DARK.
  RECON_SWEEP_ENABLED?: string;           // "1" enables the 04:00 cron; default off
  RECON_SWEEP_DAYS?: string;              // legacy short window (days); fallback only
  RECON_SWEEP_DRAIN_DAYS?: string;        // effective lookback (days); default "90" — must match the
                                          // weekly-digest horizon so reported drops actually get healed
  RECON_SWEEP_SHOPS?: string;             // CSV allowlist of shopify_domains; empty = all active shops
  // Shopify→IX CREATE-path normalization source. "1" builds the Normalized shape
  // in-worker from the raw Shopify order (no external Hostinger call); default/"0"
  // keeps the external normalize service. Refund + adapter paths are unaffected.
  NORMALIZE_IN_WORKER?: string;
}
