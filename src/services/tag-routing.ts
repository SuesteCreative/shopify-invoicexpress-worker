import type { Env } from "../env";
import type { SourceKind, DestinationKind } from "../storage";
import type { Normalized } from "../api/normalize-shopify";
import type { AdapterCtx } from "../adapters/types";

export interface TagRoutingRule {
  tag_name: string;
  document_type: string | null;
  series_name: string | null;
  // 'finalize' | 'draft' | null (inherit the connection's auto_finalize).
  // Added by migration 0031; older rows encoded "draft" as a document_type
  // suffix instead — see normalizeRule.
  finalize_mode?: string | null;
}

/** The document types a rule may route to, after normalization. */
export type RoutedDocType = "invoice" | "invoice_receipt" | "simplified_invoice";

const ROUTED_DOC_TYPES: readonly RoutedDocType[] = ["invoice", "invoice_receipt", "simplified_invoice"];

export interface NormalizedRoute {
  /** null = keep the connection's configured document type. */
  docType: RoutedDocType | null;
  /** null = inherit the connection's auto_finalize; true/false force it. */
  finalize: boolean | null;
  /** null = keep the connection's configured series / document set. */
  series: string | null;
}

/**
 * Collapse a stored rule into the vocabulary the adapters speak.
 *
 * Rules written before migration 0031 encode "leave it as a draft" as a
 * `_draft` suffix on the document type. We fold that back here rather than in
 * the pipeline so back-compat lives in exactly one place and survives a
 * skipped or partial backfill.
 */
export function normalizeRule(rule: TagRoutingRule): NormalizedRoute {
  const raw = String(rule.document_type ?? "").trim().toLowerCase();
  const legacyDraft = raw.endsWith("_draft");
  const base = legacyDraft ? raw.slice(0, -"_draft".length) : raw;

  const docType = (ROUTED_DOC_TYPES as readonly string[]).includes(base)
    ? (base as RoutedDocType)
    : null;

  const mode = String(rule.finalize_mode ?? "").trim().toLowerCase();
  let finalize: boolean | null = null;
  if (mode === "draft") finalize = false;
  else if (mode === "finalize") finalize = true;
  else if (legacyDraft) finalize = false;
  // A pre-0031 rule with a plain (non-draft) type used to force finalize.
  else if (!mode && docType) finalize = true;

  const series = String(rule.series_name ?? "").trim() || null;
  return { docType, finalize, series };
}

// Load rules ordered by created_at ASC so first-inserted = highest priority.
export async function loadTagRoutingRules(
  env: Env,
  userId: string,
  sourceKind: SourceKind,
  destinationKind: DestinationKind,
): Promise<TagRoutingRule[]> {
  const db = (env as any).DB;
  if (!db) return [];

  try {
    const result = await db.prepare(
      `SELECT tag_name, document_type, series_name, finalize_mode
       FROM tag_routing_rules
       WHERE user_id = ? AND source_kind = ? AND destination_kind = ?
       ORDER BY created_at ASC`,
    ).bind(userId, sourceKind, destinationKind).all();

    return (result.results ?? []) as TagRoutingRule[];
  } catch (err) {
    console.warn("[tag-routing] loadTagRoutingRules failed:", err);
    return [];
  }
}

// Build a flat set of matchable strings from the order and return the first
// rule whose tag_name is present in that set.
//
// Shopify:  order.tags is a string[] of exact tag values (e.g. "property_id:686585").
// Stripe/EuPago: metadata is normalised into note_attributes [{name, value}].
//   We match "${name}:${value}" (exact metadata pair) and just "${name}" (key-only).
//
// A rule name joined by ` + ` requires every part (see ruleMatches).
//
// First rule in created_at ASC order wins.
export function matchTagRouting(
  order: Normalized["order"],
  rules: TagRoutingRule[],
  opts?: { byCountry?: boolean },
): TagRoutingRule | null {
  if (rules.length === 0) return null;

  const candidates = new Set<string>();

  // The buyer's own country, for merchants who file each destination into its
  // own document series. Opt-in (`tag_route_by_country`) because it invents
  // matchable strings the merchant did not write: a rule someone named
  // `country:AU` for an unrelated reason would start matching sales to
  // Australia. Billing first — it is who the invoice is addressed to — with
  // shipping as the fallback for a payment that collected only a delivery
  // address. Metadata still wins by being the same string: a merchant sending
  // `country=AU` produces the identical candidate.
  if (opts?.byCountry) {
    const cc = String(
      order.billing_address?.country_code || order.shipping_address?.country_code || "",
    ).trim().toUpperCase();
    if (cc) {
      candidates.add(`country:${cc}`);
      candidates.add(`country_code:${cc}`);
    }
  }

  // Shopify order tags. The normalize API returns an array, but the raw
  // Shopify payload is comma-separated — handle both to be safe.
  if (Array.isArray(order.tags)) {
    for (const tag of order.tags) {
      if (tag == null) continue;
      const s = String(tag).trim();
      if (s.includes(",")) {
        for (const t of s.split(",")) { const tt = t.trim(); if (tt) candidates.add(tt); }
      } else if (s) {
        candidates.add(s);
      }
    }
  }

  // Hints the source built from the payment itself (`stripe:origin:checkout`,
  // `stripe:payment_method:multibanco`, `stripe:description:…`). They exist only
  // when the connection asked for them, which is why there is no flag here, and
  // they are namespaced so they cannot collide with a tag the merchant wrote.
  const hints = (order as any)?.meta?.routing_hints;
  if (Array.isArray(hints)) {
    for (const hint of hints) {
      const s = String(hint ?? "").trim();
      if (s) candidates.add(s);
    }
  }

  // note_attributes (Stripe metadata / Shopify custom attributes)
  if (Array.isArray(order.note_attributes)) {
    for (const attr of order.note_attributes as Array<{ name?: string; value?: unknown }>) {
      const name = String(attr?.name ?? "").trim();
      const value = String(attr?.value ?? "").trim();
      if (name) {
        candidates.add(name);
        if (value) candidates.add(`${name}:${value}`);
      }
    }
  }

  for (const rule of rules) {
    if (ruleMatches(rule.tag_name, candidates)) return rule;
  }
  return null;
}

/**
 * Does this rule's name match what the sale carries?
 *
 * A plain name is an exact match against one candidate. A name joined by ` + `
 * requires ALL of its parts, which is what makes a price-based rule safe: a
 * booking plugin's three fixed prices are only that plugin's prices among
 * payments the plugin created, and `stripe:origin:api + stripe:amount:45.00`
 * says exactly that. Without it, a hand-written invoice that happened to total
 * the same 45.00 € would be filed in the plugin's series.
 *
 * The separator is spaced on purpose. A bare `+` appears inside real values —
 * `phone:+351912345678` is a metadata pair a merchant might route on — and
 * splitting on it would break rules that work today.
 */
function ruleMatches(tagName: string, candidates: Set<string>): boolean {
  const name = String(tagName ?? "").trim();
  if (!name) return false;
  if (!name.includes(" + ")) return candidates.has(name);

  const parts = name.split(" + ").map(p => p.trim()).filter(Boolean);
  return parts.length > 0 && parts.every(p => candidates.has(p));
}

/**
 * Rebuild the route stored on `processed_orders.routed_json` at create time.
 *
 * Never throws: a malformed or absent value means "no rule matched", which is
 * the same as the pre-0031 behaviour. Losing a route degrades to the connection
 * default — it must not fail a finalize.
 */
export function parseStoredRoute(json: string | null | undefined): NormalizedRoute | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<NormalizedRoute>;
    const docType = (ROUTED_DOC_TYPES as readonly string[]).includes(String(parsed?.docType))
      ? (parsed.docType as RoutedDocType)
      : null;
    const finalize = typeof parsed?.finalize === "boolean" ? parsed.finalize : null;
    const series = String(parsed?.series ?? "").trim() || null;
    if (!docType && finalize === null && !series) return null;
    return { docType, finalize, series };
  } catch {
    return null;
  }
}

/**
 * Apply a matched rule to the adapter context.
 *
 * Both destinations honour the same three choices — document type, series and
 * draft-vs-finalize — they just store them under different keys. Keeping the
 * mapping here means the pipeline and the Lodgify instalment path cannot drift
 * apart again (they were duplicated, and only the Moloni half handled drafts).
 *
 * Returns a new ctx; the caller reassigns.
 */
export function applyTagRoute(
  ctx: AdapterCtx,
  destination: DestinationKind,
  route: NormalizedRoute,
): AdapterCtx {
  // auto_finalize is a shared behaviour toggle: it lives in the legacy
  // `integrations` row for every destination, so it is set the same way here.
  const config = route.finalize === null
    ? ctx.config
    : { ...ctx.config, auto_finalize: route.finalize ? 1 : 0 };

  if (destination === "invoicexpress") {
    return {
      ...ctx,
      config: {
        ...config,
        ...(route.docType ? { ix_document_type: route.docType } : {}),
        ...(route.series ? { ix_sequence_name: route.series } : {}),
      },
    };
  }

  if (destination === "moloni") {
    return {
      ...ctx,
      config,
      destinationConfig: {
        ...ctx.destinationConfig,
        // Clearing the numeric id forces getMoloniCfg down its lazy
        // name -> id resolution branch, so the rule's document set wins over
        // whatever id the connection was configured with.
        ...(route.series ? { moloni_document_set_id: null, moloni_document_set_name: route.series } : {}),
        ...(route.docType ? { moloni_document_type: route.docType } : {}),
      },
    };
  }

  // Vendus and any future destination: honour the finalize choice only.
  return { ...ctx, config };
}
