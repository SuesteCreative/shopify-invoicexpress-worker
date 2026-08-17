/**
 * Where a dev-mode recovery action is sent, and in what shape.
 *
 * Pure and separate from the panel so it can be tested: the payload key for the
 * record being acted on differs per connection (`order_number` on the legacy
 * Shopify routes, `external_id` on the generic ones), and getting it wrong is
 * invisible in the UI — the form looks right and the request quietly means
 * something else.
 */

export type RecoveryAction =
    | "backfill" | "reemit" | "delete-draft" | "issue-credit-note" | "finalize-drafts";

export interface ConnectionCapabilities {
    backfill: boolean;
    reemit: boolean;
    forceReemit: boolean;
    deleteDraft: boolean;
    creditNote: boolean;
    finalizeDrafts: boolean;
    orderNumberFilter: boolean;
    paidTotals: boolean;
}

export interface Connection {
    source: string;
    destination: string;
    label: string;
    external_id: { kind: string; label: string; placeholder: string };
    capabilities: ConnectionCapabilities;
    /** Where this connection starts invoicing: sales paid before it are skipped
     *  by every automatic path AND by the backfill. Null on the legacy Shopify
     *  stand-in, which has no connection row to carry one. */
    invoice_cutoff?: string | null;
}

export const connKey = (c: Connection) => `${c.source}:${c.destination}`;

/**
 * Shopify→InvoiceXpress still goes to the legacy per-shop endpoints.
 *
 * The generic engine issues through the adapter pipeline, while the legacy
 * Shopify create path has an InvoiceXpress client-recreate fallback the adapter
 * path does not. Losing that silently on the source with the most volume is
 * worse than one release carrying two code paths.
 */
export function usesLegacyShopifyRoutes(conn: Connection): boolean {
    return conn.source === "shopify" && conn.destination === "invoicexpress";
}

export interface RecoveryRequest {
    url: string;
    body: Record<string, unknown>;
}

export function buildRecoveryRequest(
    conn: Connection,
    action: RecoveryAction,
    targetUserId: string,
    payload: Record<string, unknown>,
): RecoveryRequest {
    const legacy = usesLegacyShopifyRoutes(conn);
    return {
        url: legacy
            ? `/api/admin/dev-mode/${action}`
            : `/api/admin/dev-mode/connection/${action}`,
        // The generic routes need to know which connection; the legacy ones
        // resolve the shop from the user and would ignore it.
        body: legacy
            ? { targetUserId, ...payload }
            : { targetUserId, source: conn.source, destination: conn.destination, ...payload },
    };
}

/**
 * The record identifier, keyed the way the target endpoint expects it.
 *
 * Legacy Shopify takes a numeric order number. Everything else takes the
 * source's own external id as a string — a Stripe payment intent is `pi_3Tp…`
 * and coercing it through Number() yields NaN.
 */
export function recordIdPayload(conn: Connection, input: string): Record<string, unknown> {
    const trimmed = input.trim();
    return usesLegacyShopifyRoutes(conn)
        ? { order_number: Number(trimmed) }
        : { external_id: trimmed };
}
