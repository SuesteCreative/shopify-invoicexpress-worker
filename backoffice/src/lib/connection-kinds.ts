/**
 * The source and destination kinds a connection can have.
 *
 * Source of truth is the worker's `src/adapters/types.ts` — the adapter registry
 * decides what can actually run. This file mirrors it for the backoffice, and
 * the two must be changed together: the previous copy of these lists had gone
 * stale (missing eupago, lodgify and vendus), which meant the connections API
 * rejected writes for connection kinds that were already live in production.
 */

export const SOURCE_KINDS = ["shopify", "stripe", "eupago", "lodgify"] as const;
export const DESTINATION_KINDS = ["invoicexpress", "moloni", "vendus"] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];
export type DestinationKind = (typeof DESTINATION_KINDS)[number];

export const CONNECTION_STATUSES = ["draft", "active", "paused", "error"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export function isSourceKind(v: unknown): v is SourceKind {
    return typeof v === "string" && (SOURCE_KINDS as readonly string[]).includes(v);
}

export function isDestinationKind(v: unknown): v is DestinationKind {
    return typeof v === "string" && (DESTINATION_KINDS as readonly string[]).includes(v);
}

const LABELS: Record<string, string> = {
    shopify: "Shopify",
    stripe: "Stripe",
    eupago: "EuPago",
    lodgify: "Lodgify",
    invoicexpress: "IX API",
    moloni: "Moloni",
    vendus: "Vendus",
};

/** Display name for a single kind; unknown kinds render as themselves. */
export function kindLabel(kind: string): string {
    return LABELS[kind] ?? kind;
}

/** "Shopify → IX API" */
export function connectionLabel(source: string, destination: string): string {
    return `${kindLabel(source)} → ${kindLabel(destination)}`;
}
