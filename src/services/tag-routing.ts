import type { Env } from "../env";
import type { SourceKind, DestinationKind } from "../storage";
import type { Normalized } from "../api/normalize-shopify";

export interface TagRoutingRule {
  tag_name: string;
  document_type: string | null;
  series_name: string | null;
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
      `SELECT tag_name, document_type, series_name
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
