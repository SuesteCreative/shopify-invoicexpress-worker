export interface Env {
  INVOICE_KV: KVNamespace;
  DB: D1Database;
  NORMALIZE_SHOPIFY_ORDER_API_KEY: string;
  /** Populated by Cloudflare on every deploy, whoever made it. See /admin/version. */
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
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
  LODGIFY_SETTLE_AUTO?: string;           // "1" lets the poll issue Recibos on its own; default off
  LODGIFY_SETTLE_MAX_DOCS?: string;       // documents settled per poll pass; default 40
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
  RECON_SWEEP_BUDGET_MS?: string;         // wall-clock cap for the full-scan backstop; default 480000 (8m)
  INCIDENT_HEAL_BUDGET_MS?: string;       // wall-clock cap for the incident heal; default 240000 (4m)
  INCIDENT_HEAL_MAX_ORDERS?: string;      // per-shop cap per run, so one backlog cannot starve the rest; default 25
  RECON_SWEEP_MAX_ORDERS?: string;        // per-shop order cap per sweep run, so one big shop still returns; default 25
  RECON_SWEEP_ORDER_DEADLINE_MS?: string; // give up on one order rather than lose the pass to it; default 45000
  RECON_REF_CONCURRENCY?: string;         // reference probes in flight on the Conciliação recovery pass; default 6
  RECON_SWEEP_STALE_HOURS?: string;       // alert when a shop hasn't completed a sweep pass in this long; default 48
  // Stripe→(Moloni/IX/Vendus) self-heal. Same backstop idea as the Shopify sweep but
  // for Stripe-source connections: re-emits any succeeded Stripe payment in the window
  // that has no processed_orders row (an orphan — e.g. a setup-day draft later deleted).
  // Routes to the connection's real destination; keeps drafts (never finalizes). Ships DARK.
  STRIPE_HEAL_ENABLED?: string;           // "1" enables the Stripe heal in the 04:00 cron; default off
  STRIPE_HEAL_DAYS?: string;              // lookback window (days); default "30"
  STRIPE_HEAL_USERS?: string;             // CSV allowlist of user_ids; empty = all active Stripe connections
  // Shopify→IX CREATE-path normalization source. "1" builds the Normalized shape
  // in-worker from the raw Shopify order (no external Hostinger call); default/"0"
  // keeps the external normalize service. Refund + adapter paths are unaffected.
  NORMALIZE_IN_WORKER?: string;
  // Document verification sweep (04:00). Reads each issued document back from the
  // destination and compares it with the `built` event that recorded what we sent.
  // Deliberately NOT on the create path: that would add one ix-proxy read per
  // document, in bursts, from every backfill loop. Ships DARK.
  DOC_VERIFY_ENABLED?: string;            // "1" enables it in the 04:00 cron; default off
  DOC_VERIFY_DAYS?: string;               // lookback over `built` events; default "3". Widen to backfill.
  DOC_VERIFY_LIMIT?: string;              // max documents examined per run; default "500"
  DOC_VERIFY_BUDGET_MS?: string;          // wall-clock budget; default 8 min, same as the recon sweep

  // Lodgify egress. Lodgify blocks this Worker's egress and can only allowlist
  // by IP address (support, in writing, 2026-08-18), so every Lodgify call has
  // to leave through a fixed-IP relay. See `src/services/lodgify-api.ts`.
  //
  // MODE and URL live in `wrangler.jsonc` vars ON PURPOSE: they are not secrets,
  // they are reviewable in git, and they survive a bare `wrangler deploy` — which
  // has silently dropped this Worker's secrets before. Absent MODE means
  // "gateway", i.e. fail closed: a lost variable must never restore direct,
  // unallowlisted egress. Only KEY is a `wrangler secret`.
  LODGIFY_EGRESS_MODE?: string;           // "gateway" (default) | "direct"
  LODGIFY_GATEWAY_URL?: string;           // relay origin, e.g. https://rioko-lodgify.fly.dev
  LODGIFY_GATEWAY_KEY?: string;           // shared secret — `wrangler secret put`, never a var

  // Which commit is actually running. Stamped by `npm run deploy` at deploy
  // time (`wrangler deploy --var`), never committed — a value checked into the
  // repo is a value that goes stale and lies. Absent means the worker was
  // deployed by a bare `wrangler deploy`, and /admin/version says so rather
  // than guessing. Cloudflare reports only an opaque version id and a wall
  // clock, which is why "is the fix live?" used to be answered by comparing
  // commit timestamps against deployment timestamps across two timezones.
  GIT_SHA?: string;
  GIT_BRANCH?: string;
  GIT_DIRTY?: string;                     // "1" when the tree had uncommitted changes
  BUILT_AT?: string;                      // ISO timestamp of the deploy
}
