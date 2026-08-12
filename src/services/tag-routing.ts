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
// First rule in created_at ASC order wins.
export function matchTagRouting(
  order: Normalized["order"],
  rules: TagRoutingRule[],
): TagRoutingRule | null {
  if (rules.length === 0) return null;

  const candidates = new Set<string>();

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
    if (candidates.has(rule.tag_name.trim())) return rule;
  }
  return null;
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
