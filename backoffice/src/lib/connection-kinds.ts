/**
 * The source and destination kinds a connection can have.
 *
 * Source of truth is the worker's `src/adapters/types.ts` — the adapter registry
 * decides what can actually run. This file mirrors it for the backoffice, and
 * the two must be changed together: the previous copy of these lists had gone
 * stale (missing eupago, lodgify and vendus), which meant the connections API
 * rejected writes for connection kinds that were already live in production.
 */

export const SOURCE_KINDS = ["shopify", "stripe", "stripe_connect", "eupago", "lodgify"] as const;
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

/**
 * The source kind a request names — or null when it names one we do not know.
 *
 * Routes used to normalize with a ternary chain that ended in a fallback:
 * `raw === "shopify" ? "shopify" : "stripe"`. That reads like a default and
 * behaves like a redirect. A request naming `lodgify` or `stripe_connect` did
 * not fail — it silently addressed a DIFFERENT connection of the same account,
 * and then read from it, wrote to it, or deleted it. Measured across seven
 * routes: the Lodgify→Vendus wizard stored its API key on the `stripe:vendus`
 * connection, and the tag-routing page asked for a Stripe Connect merchant's
 * series and was shown the Lodgify connection's.
 *
 * Absent still means the route's historical default, because a caller that
 * names nothing is a caller that predates the parameter. Present-and-unknown is
 * a caller bug, and the answer to a caller bug is 400, not another account's
 * connection.
 */
export function sourceKindOrNull(raw: unknown, whenAbsent: SourceKind): SourceKind | null {
    if (raw === undefined || raw === null || raw === "") return whenAbsent;
    return isSourceKind(raw) ? raw : null;
}

/** The 400 body every caller of `sourceKindOrNull` answers an unknown kind with. */
export function unknownSourceKindError(raw: unknown): string {
    return `Unknown source_kind ${JSON.stringify(raw)} — must be one of: ${SOURCE_KINDS.join(", ")}`;
}

/**
 * The destination half of the same rule, for the same reason.
 *
 * `body.destination_kind === "moloni" ? "moloni" : "invoicexpress"` rewrote the
 * Stripe→Vendus wizard's stated destination to InvoiceXpress, so its source
 * credentials landed on a connection naming a destination the merchant never
 * configured.
 */
export function destinationKindOrNull(raw: unknown, whenAbsent: DestinationKind): DestinationKind | null {
    if (raw === undefined || raw === null || raw === "") return whenAbsent;
    return isDestinationKind(raw) ? raw : null;
}

const LABELS: Record<string, string> = {
    shopify: "Shopify",
    // "Legacy" is the merchant-facing name for the original integration: the one
    // authenticated with a restricted key the merchant pastes in, as opposed to
    // Connect's OAuth. Only the LABEL changes — `stripe` remains the stored
    // `source_kind` in connections, subscriptions, processed_orders,
    // document_events and every query that reads them.
    stripe: "Stripe Legacy",
    // Deliberately distinct: an account can hold both kinds at once, and a
    // support conversation about "the Stripe connection" has to be able to name
    // which one.
    stripe_connect: "Stripe Connect",
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
