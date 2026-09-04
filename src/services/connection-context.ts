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
const CONNECTION_FISCAL_FLAGS = [
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
): IRequestConfig {
  if (!destinationConfig) return config;
  const c = config as any;
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
  return config;
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
        invoiceCutoff: null,
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
      projectConnectionBehaviour(config, destinationConfig);
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
    const appStorage = new AppStorage(env, null, opts.userId);
    const config = await appStorage.loadConfig();
    if (config?.shopify_domain) {
      return {
        ok: true,
        ctx: {
          source: "shopify", destination: "invoicexpress",
          sourceConfig: {}, destinationConfig: {},
          config, userId: opts.userId, scope: config.shopify_domain,
          invoiceCutoff: null,
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
      .prepare("SELECT shopify_domain FROM integrations WHERE user_id = ?")
      .bind(userId).first();
    if (legacy?.shopify_domain) {
      out.push({
        source: "shopify",
        destination: "invoicexpress",
        label: connectionLabelOf("shopify", "invoicexpress"),
      });
    }
  }
  return out;
}
