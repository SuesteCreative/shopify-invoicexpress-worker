import type { Env } from "../env";
import type { IRequestConfig, SourceKind, DestinationKind } from "../storage";
import { AppStorage } from "../storage";

/**
 * Everything an operation on a merchant's connection needs, resolved once from
 * either a Shopify shop domain (legacy) or a user's `connections` row.
 *
 * This exists because the same six lines — "load the connection, parse both
 * config blobs, load the legacy `integrations` row, synthesize one if it isn't
 * there, project the connection's behaviour flags onto it" — were written
 * independently in six places (the Lodgify webhook, the Lodgify poll, the
 * Lodgify take-back, the Stripe re-emit, reconciliation, and the Stripe heal).
 * They did not agree with each other, and the ones that skipped the projection
 * step are the reason a Moloni-only client could not turn auto-finalize or buyer
 * emails on at all: their settings live on the connection, and the code read the
 * legacy row that does not exist for them.
 */
/**
 * The cutoff of a legacy Shopify integration: the date it starts invoicing from.
 *
 * Same contract as `connections.invoice_cutoff` — the explicit value if the
 * operator moved it, else the day the integration was set up. Before migration
 * 0055 the legacy row had no column at all, so every Shopify path was handed
 * `null` and treated the merchant's entire order history as Rioko's to issue.
 *
 * Normalised here because SQLite writes `created_at` as "2026-09-08 14:52:25"
 * (UTC, no zone) and every reader downstream calls `Date.parse` on it, which
 * reads a zoneless string as LOCAL time. That is a no-op inside a Worker and
 * wrong everywhere else the value travels.
 */
export function legacyInvoiceCutoff(config: IRequestConfig | null | undefined): string | null {
  const raw = String(config?.invoice_cutoff ?? config?.created_at ?? "").trim();
  if (!raw) return null;
  const iso = /Z$|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw.replace(" ", "T")}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export interface ConnectionContext {
  source: SourceKind;
  destination: DestinationKind;
  sourceConfig: Record<string, any>;
  destinationConfig: Record<string, any>;
  /** The legacy `integrations` row, or a synthesized stand-in. Never null. */
  config: IRequestConfig;
  userId: string | null;
  /** AppStorage key the override tables (match/decision) are scoped by: the
   *  Shopify domain for Shopify, else `u:<userId>`. */
  scope: string;
  /** When Rioko took over invoicing for this connection (`invoice_cutoff`, else
   *  the connection's `created_at`). Sales before it were never ours to issue.
   *  Null for legacy Shopify integrations, which have no connection row. */
  invoiceCutoff?: string | null;
  /** "stripe → moloni". For log lines and incident emails. */
  connectionLabel: string;
}

export interface ConnectionSummary {
  source: SourceKind;
  destination: DestinationKind;
  label: string;
  /** Effective `invoice_cutoff` (the column, else the connection's created_at).
   *  Absent on the legacy Shopify stand-in, which has no connection row. */
  invoiceCutoff?: string | null;
}

export type ResolveConnectionResult =
  | { ok: true; ctx: ConnectionContext }
  | { ok: false; error: "not_found" }
  | { ok: false; error: "ambiguous"; options: ConnectionSummary[] };

export interface ResolveConnectionOptions {
  shop?: string | null;
  userId?: string | null;
  source?: SourceKind;
  destination?: DestinationKind;
  /**
   * What to do when the user has several active connections and the caller gave
   * no source/destination to pick between them.
   *
   * `"error"` (default) is right for anything that WRITES: guessing which
   * connection an operator meant to re-emit into is how a document lands at the
   * wrong destination. `"pick_latest"` preserves the historical
   * ORDER BY updated_at DESC LIMIT 1 behaviour for read-only callers that
   * predate the discriminator.
   */
  onAmbiguous?: "error" | "pick_latest";
}

function parseJson(s: string | null | undefined): Record<string, any> {
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}

export function connectionLabelOf(source: string, destination: string): string {
  return `${source} → ${destination}`;
}

/**
 * A stand-in for the legacy `integrations` row, for users who never had one.
 *
 * Everything the pipeline reads off `config` must have a defined default here,
 * because an `undefined` flag reads as "off" in some call sites and "unset,
 * inherit" in others. The behaviour flags are then overlaid from the connection
 * by `projectConnectionBehaviour`.
 */
export function synthLegacyConfig(userId: string): IRequestConfig {
  return {
    id: null,
    user_id: userId,
    shopify_domain: null,
    only_invoice_when_paid: 0,
    auto_finalize: 0,
    b2b_reverse_charge: 0,
    ix_send_email: 0,
    // Migration 0037. Spelled out rather than left undefined for the reason in
    // the comment above: an absent flag reads as "off" in one call site and
    // "unset, inherit" in another, and these decide a document's tax regime.
    ix_derive_exemption: 0,
    ix_adapter_safety_nets: 0,
    stripe_tax_from_source: 0,
    tag_route_by_country: 0,
    ix_require_series: 0,
    stripe_routing_hints: 0,
    stripe_metadata_map: null,
    ix_multicurrency: 0,
  } as unknown as IRequestConfig;
}

/**
 * The migration-0037 switches, in the one place that knows how to read them off
 * a connection blob. Booleans there, SQLite 0/1 on the legacy row.
 */
/**
 * What a connection may state about the documents it issues, as opposed to how
 * it behaves. Read by `projectConnectionBehaviour`.
 *
 * `force_tax_rate` and `is_paused` deliberately stay shared: the pause toggle
 * writes the legacy row, so projecting a connection's `is_paused` would let a
 * connection that never stated one silently resume a paused account. They move
 * when the toggle moves with them.
 */
export const CONNECTION_FISCAL_IDENTITY = [
  "ix_sequence_name",
  "ix_exemption_reason",
  "ix_document_type",
] as const;

/**
 * Fiscal settings that used to reach a connection from the ACCOUNT's legacy row.
 *
 * The legacy `integrations` row belongs to one integration — in practice the
 * account's Shopify shop, or (for a client who never had one) their single
 * Stripe→IX setup. It was never meant to govern a second, unrelated integration,
 * and when it did the result was invisible: measured 09/09/2026, a shop with
 * `force_tax_rate = 0` issued a different business's Stripe sales at 0% with an
 * exemption code, ignoring the 23% that connection had been configured with.
 *
 * A merchant may run every combination at once, and each one is its own
 * business decision. So for a connection-based source these are read from the
 * CONNECTION and nowhere else: stated there, or neutral. Shopify keeps reading
 * the legacy row, which is its own.
 */
export const CONNECTION_FISCAL_RATES = [
  "force_tax_rate",
  "force_shipping_tax_rate",
] as const;

export const CONNECTION_FISCAL_TOGGLES = [
  "b2b_reverse_charge",
  "oss_enabled",
  "vat_included",
] as const;

export const CONNECTION_FISCAL_FLAGS = [
  "ix_derive_exemption",
  "ix_adapter_safety_nets",
  "stripe_tax_from_source",
  "tag_route_by_country",
  "ix_require_series",
  "ix_multicurrency",
  "stripe_routing_hints",
] as const;

/**
 * Overlay the connection's own behaviour settings onto the legacy config the
 * pipeline reads.
 *
 * The connection must win for its own traffic: one user can run a Shopify→IX
 * shop that finalizes and mails buyers alongside a Stripe→Moloni flow that
 * leaves drafts and stays quiet. Reading only the legacy row conflates the two.
 *
 * An absent key leaves the legacy value alone — a connection that never stated a
 * preference does not get to overrule one.
 *
 * Forgetting this call is the difference between a draft and a certified fiscal
 * document, which is why it lives inside the resolver rather than at each call
 * site.
 */
export function projectConnectionBehaviour(
  config: IRequestConfig,
  destinationConfig?: Record<string, any>,
  /**
   * The connection's source. When given and not "shopify", the fiscal settings
   * in CONNECTION_FISCAL_RATES / _TOGGLES are isolated: taken from this
   * connection or left neutral, never inherited from the account's legacy row.
   * Omitted keeps the historical inherit-everything behaviour, which is what
   * every legacy Shopify caller wants.
   */
  source?: SourceKind,
): IRequestConfig {
  const c = config as any;
  const isolate = !!source && source !== "shopify";

  // Isolation runs even with no destination config: a connection that has said
  // nothing must still not inherit another integration's rates.
  if (isolate) {
    for (const key of CONNECTION_FISCAL_RATES) {
      const stated = Number(destinationConfig?.[key]);
      c[key] = Number.isFinite(stated) ? stated : null;
    }
    for (const key of CONNECTION_FISCAL_TOGGLES) {
      const stated = destinationConfig?.[key];
      if (typeof stated === "boolean") c[key] = stated ? 1 : 0;
      else if (stated === 0 || stated === 1) c[key] = stated;
      else c[key] = 0;
    }
    // Same reasoning for the exemption code: an account-level M40 is one
    // integration's fiscal identity, not every integration's. The adapters
    // supply their own default when it is absent.
    if (!destinationConfig?.ix_exemption_reason && !destinationConfig?.exemption_reason) {
      c.ix_exemption_reason = null;
    }
    // Same for the reverse-charge code. It only matters when b2b_reverse_charge
    // is on, which is itself isolated above, but a connection that turns RC on
    // must not silently borrow another integration's article.
    if (typeof destinationConfig?.ix_b2b_exemption_reason === "string" && destinationConfig.ix_b2b_exemption_reason.trim()) {
      c.ix_b2b_exemption_reason = destinationConfig.ix_b2b_exemption_reason.trim();
    } else {
      c.ix_b2b_exemption_reason = null;
    }
    // The series and the document type, the last two that still leaked.
    //
    // Two integrations of one account may file into the SAME InvoiceXpress
    // account and must still use DIFFERENT series — Wim Hof Method files Shopify
    // orders into WH-25-1 and Stripe sales into FR-ROW, in one IX account. That
    // works only because the Stripe connection states its own; a connection that
    // stated nothing inherited the shop's, which is another integration's fiscal
    // identity and, for a series communicated to the AT, the wrong one.
    //
    // Absent now means absent: the destination applies its own default, which is
    // this connection's own unstated choice rather than somebody else's stated
    // one. Measured across the fleet before changing it — every live connection
    // already states both, so nothing moves today.
    for (const key of ["ix_sequence_name", "ix_document_type"] as const) {
      const stated = destinationConfig?.[key];
      c[key] = typeof stated === "string" && stated.trim() ? stated.trim() : null;
    }
  }

  if (!destinationConfig) return config;
  if (typeof destinationConfig.auto_finalize === "boolean") {
    c.auto_finalize = destinationConfig.auto_finalize ? 1 : 0;
  }
  if (typeof destinationConfig.send_email === "boolean") {
    c.ix_send_email = destinationConfig.send_email ? 1 : 0;
  }
  // A connection-based client has no legacy row to hold this, so without the
  // projection its standing invoice note would be settable in the console and
  // silently absent from every document it issued.
  if (typeof destinationConfig.custom_invoice_note === "string") {
    c.custom_invoice_note = destinationConfig.custom_invoice_note;
  }
  // Same reason, for the 0037 switches: a Stripe→IX connection has a legacy row
  // (its IX credentials live there) but no `shopify_domain`, and the fiscal
  // console hides the legacy section for exactly those clients. Without this
  // projection the switches would be settable only by hand-written SQL.
  for (const flag of CONNECTION_FISCAL_FLAGS) {
    if (typeof destinationConfig[flag] === "boolean") {
      c[flag] = destinationConfig[flag] ? 1 : 0;
    }
  }
  if (typeof destinationConfig.stripe_metadata_map === "string") {
    c.stripe_metadata_map = destinationConfig.stripe_metadata_map;
  }
  // The fiscal identity of the documents this connection issues: which series
  // they are filed in, which exemption code they carry when the rate is 0%, and
  // whether they are invoices or invoice-receipts.
  //
  // Until now these came off the shared `integrations` row and nothing else, so
  // an account running two connections into the SAME InvoiceXpress account
  // could only ever have one of each — and the second wizard to be saved
  // overwrote the first. Measured on Wim Hof Method (08/09/2026), who files
  // Stripe sales into `FR-ROW` (the fallback behind 62 per-country series) and
  // Shopify orders into `WH-25-1`: the Stripe wizard had already replaced the
  // shop's series on the shared row, so the shop was one order away from
  // filing into the wrong series.
  //
  // Blank means "not stated" and inherits the legacy row. That is what an empty
  // field in the wizard means, and it is the only way back to inheriting once a
  // connection has stated something.
  for (const key of CONNECTION_FISCAL_IDENTITY) {
    const value = destinationConfig[key];
    if (typeof value === "string" && value.trim() !== "") {
      c[key] = value.trim();
    }
  }
  return config;
}

/**
 * The connection a queued Stripe event belongs to.
 *
 * The destination is part of a connection's identity, not a detail of it: one
 * account may run `stripe → invoicexpress` and `stripe → moloni` at the same
 * time, into different series, with different exemption codes and different tax
 * settings. The queue consumer used to ask only for "an active connection for
 * this user and source", with no destination filter and no ORDER BY — so which
 * of the two issued the document was decided by SQLite's row order.
 *
 * `destinationKind` is absent for a message enqueued before the webhook started
 * stamping it. Then, and when the stated destination no longer has an active
 * connection, this falls back to the OLDEST active one and says so: billing the
 * sale against a defensible guess beats dropping it silently.
 */
export async function pickStripeConnection(
  db: any,
  userId: string,
  sourceKind: string,
  destinationKind?: string | null,
): Promise<any | null> {
  const SELECT = `SELECT destination_kind, destination_config_json, behavior_json, source_config_json
     FROM connections WHERE user_id = ? AND source_kind = ? AND status = 'active'`;

  if (destinationKind) {
    const exact = await db.prepare(`${SELECT} AND destination_kind = ? LIMIT 1`)
      .bind(userId, sourceKind, destinationKind).first();
    if (exact) return exact;
    console.warn(`[Stripe] ${userId}/${sourceKind} has no active connection into ${destinationKind}; falling back to the oldest`);
  }

  return await db.prepare(`${SELECT} ORDER BY created_at ASC LIMIT 1`)
    .bind(userId, sourceKind).first();
}

/**
 * Resolve the connection an operation should act on.
 *
 * Order of precedence:
 *  1. an explicit `shop` — always legacy Shopify→InvoiceXpress (back-compat for
 *     every existing `?shop=` caller);
 *  2. the user's active `connections` rows, filtered by `source`/`destination`;
 *  3. the legacy `integrations` row keyed by user, for Shopify merchants who
 *     predate the connections table.
 */
export async function resolveConnectionContext(
  env: Env,
  opts: ResolveConnectionOptions,
): Promise<ResolveConnectionResult> {
  if (opts.shop) {
    const appStorage = new AppStorage(env, opts.shop);
    const config = await appStorage.loadConfig();
    if (!config) return { ok: false, error: "not_found" };
    return {
      ok: true,
      ctx: {
        source: "shopify", destination: "invoicexpress",
        sourceConfig: {}, destinationConfig: {},
        config, userId: config.user_id ?? opts.userId ?? null,
        scope: opts.shop,
        invoiceCutoff: legacyInvoiceCutoff(config),
        connectionLabel: connectionLabelOf("shopify", "invoicexpress"),
      },
    };
  }

  if (opts.userId) {
    const rows: any[] = ((await env.DB.prepare(
      `SELECT source_kind, destination_kind, source_config_json, destination_config_json,
              invoice_cutoff, created_at
       FROM connections WHERE user_id = ? AND status = 'active'
       ORDER BY updated_at DESC`
    ).bind(opts.userId).all()).results ?? []) as any[];

    const matching = rows.filter((r) =>
      (!opts.source || r.source_kind === opts.source) &&
      (!opts.destination || r.destination_kind === opts.destination));

    if (matching.length > 1 && (opts.onAmbiguous ?? "error") === "error") {
      return {
        ok: false,
        error: "ambiguous",
        options: matching.map((r) => ({
          source: r.source_kind as SourceKind,
          destination: r.destination_kind as DestinationKind,
          label: connectionLabelOf(r.source_kind, r.destination_kind),
        })),
      };
    }

    const conn = matching[0];
    if (conn) {
      const source = conn.source_kind as SourceKind;
      const destination = conn.destination_kind as DestinationKind;
      const destinationConfig = parseJson(conn.destination_config_json);
      const appStorage = new AppStorage(env, null, opts.userId);
      // A Shopify connection still has a legacy integrations row; a Lodgify- or
      // Moloni-only user may not, so synthesize one.
      const config = (await appStorage.loadConfig()) ?? synthLegacyConfig(opts.userId);
      projectConnectionBehaviour(config, destinationConfig, source);
      const scope = source === "shopify" && config.shopify_domain
        ? config.shopify_domain
        : `u:${opts.userId}`;
      return {
        ok: true,
        ctx: {
          source, destination,
          sourceConfig: parseJson(conn.source_config_json),
          destinationConfig,
          config, userId: opts.userId, scope,
          invoiceCutoff: (conn.invoice_cutoff ?? conn.created_at) ?? null,
          connectionLabel: connectionLabelOf(source, destination),
        },
      };
    }

    // No connection row — fall back to the legacy Shopify integration by user.
    //
    // ONLY when the caller did not name a different integration. Asking for the
    // Stripe connection of an account that has none and being handed its Shopify
    // shop is not a fallback, it is a wrong answer: the caller goes on to issue,
    // finalize or credit documents against an integration it never asked about.
    // A caller that named one and cannot have it needs to hear "not_found".
    const askedForSomethingElse =
      (opts.source && opts.source !== "shopify")
      || (opts.destination && opts.destination !== "invoicexpress");
    if (askedForSomethingElse) return { ok: false, error: "not_found" };

    const appStorage = new AppStorage(env, null, opts.userId);
    const config = await appStorage.loadConfig();
    if (config?.shopify_domain) {
      return {
        ok: true,
        ctx: {
          source: "shopify", destination: "invoicexpress",
          sourceConfig: {}, destinationConfig: {},
          config, userId: opts.userId, scope: config.shopify_domain,
          invoiceCutoff: legacyInvoiceCutoff(config),
          connectionLabel: connectionLabelOf("shopify", "invoicexpress"),
        },
      };
    }
  }

  return { ok: false, error: "not_found" };
}

/** Every active connection a user has, for the dev-mode connection selector. */
export async function listUserConnections(env: Env, userId: string): Promise<ConnectionSummary[]> {
  const rows: any[] = ((await env.DB.prepare(
    `SELECT source_kind, destination_kind, invoice_cutoff, created_at FROM connections
     WHERE user_id = ? AND status = 'active' ORDER BY updated_at DESC`
  ).bind(userId).all()).results ?? []) as any[];

  const out: ConnectionSummary[] = rows.map((r) => ({
    source: r.source_kind as SourceKind,
    destination: r.destination_kind as DestinationKind,
    label: connectionLabelOf(r.source_kind, r.destination_kind),
    // The same value backfill enforces (resolveConnectionContext falls back to
    // created_at the same way), so the panel can SAY where its cutoff comes from
    // instead of an operator inferring it from "23 skipped".
    invoiceCutoff: (r.invoice_cutoff ?? r.created_at) ?? null,
  }));

  // A merchant who predates the connections table has no row at all; surface the
  // legacy Shopify→IX integration so the panel is not empty for them.
  if (!out.some((c) => c.source === "shopify")) {
    const legacy: any = await env.DB
      .prepare("SELECT shopify_domain, invoice_cutoff, created_at FROM integrations WHERE user_id = ?")
      .bind(userId).first();
    if (legacy?.shopify_domain) {
      out.push({
        source: "shopify",
        destination: "invoicexpress",
        label: connectionLabelOf("shopify", "invoicexpress"),
        invoiceCutoff: legacyInvoiceCutoff(legacy),
      });
    }
  }
  return out;
}
/**
 * Project a connection's own "email the document to the buyer" preference onto
 * the legacy config the pipeline reads.
 *
 * `ix_send_email` lives on the legacy `integrations` row, which only exists for
 * clients who came in through Shopify→IX. A Moloni- or Vendus-only client has
 * no such row, so the synthesized fallback pinned the flag to 0 and no toggle
 * could ever turn it on. Their setting lives on the connection instead, next to
 * `auto_finalize`, and the connection must win for its own traffic: one user can
 * run a Shopify→IX shop that mails buyers and a Stripe→Moloni flow that does not.
 *
 * Absent key ⇒ leave the legacy value alone, so existing shops are unaffected.
 */
export function applyConnectionEmailPref(legacy: any, destinationConfig?: Record<string, any>): any {
  if (destinationConfig && typeof destinationConfig.send_email === "boolean") {
    legacy.ix_send_email = destinationConfig.send_email ? 1 : 0;
  }
  return legacy;
}

