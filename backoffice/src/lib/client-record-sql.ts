/**
 * Which connection a logged row belongs to — and, just as important, when the
 * honest answer is "none".
 *
 * A subscription pays for a CONNECTION since migration 0044, so "split the logs
 * per subscription" means splitting them per `<source>:<destination>`. Two of
 * the three log tables can answer that exactly and one cannot:
 *
 *   config_audit     — `scope` already carries the pair.
 *   document_events  — `source_kind` + `destination_kind` are on the row.
 *   incidents        — `connection_id` exists in the schema since 0009 and is
 *                      written by nothing: every reportIncident call site leaves
 *                      it null. There is no function for it here because there
 *                      is no answer, and guessing one from `kind` would be a
 *                      guess presented as a fact.
 *
 * Both functions return null for "not attributable", and the caller labels that
 * bucket for what it means in its own table: account-wide for a configuration
 * change, unattributed for a sale.
 */

export const LEGACY_CONNECTION_KEY = "shopify:invoicexpress";

/**
 * The connection a `config_audit` row is about, or null for the account.
 *
 * `scope` is written by lib/config-audit and takes four shapes:
 *   'connection:<source>-><destination>'  — the pair, directly
 *   'integrations'                        — the legacy row, which only ever
 *                                           describes the Shopify→IX pair
 *   'company_rules' | 'billing_event:<id>' | 'profile' | …
 *                                         — the account
 */
export function connectionKeyForScope(scope: string | null | undefined): string | null {
    const s = String(scope ?? "").trim();
    if (!s) return null;
    if (s === "integrations") return LEGACY_CONNECTION_KEY;
    if (!s.startsWith("connection:")) return null;

    const [source, destination] = s.slice("connection:".length).split("->");
    const a = (source ?? "").trim();
    const b = (destination ?? "").trim();
    return a && b ? `${a}:${b}` : null;
}

export interface DocumentEventLike {
    source_kind?: string | null;
    destination_kind?: string | null;
    shopify_domain?: string | null;
}

/**
 * The connection a `document_events` row is about, or null when nothing on the
 * row says.
 *
 * The pair is written by every current producer. Rows from before it was, and
 * rows written by the legacy Shopify handlers, carry only a shop domain — and a
 * shop domain can only ever have meant Shopify→InvoiceXpress, because that is
 * the only pair the legacy path ever ran.
 */
export function connectionKeyForDocumentEvent(row: DocumentEventLike): string | null {
    const source = (row.source_kind ?? "").trim();
    const destination = (row.destination_kind ?? "").trim();
    if (source && destination) return `${source}:${destination}`;
    if ((row.shopify_domain ?? "").trim()) return LEGACY_CONNECTION_KEY;
    return null;
}

export interface IdentityRequestRow {
    field: string;
    new_value: string | null;
    [key: string]: unknown;
}

/**
 * The fiscal identity changes a client asked for and has not been given.
 *
 * `config_audit` is append-only and carries no status, which is deliberate: a
 * request with a status column would need somebody to close it, and a queue
 * nobody closes is a queue nobody believes. The state is the comparison — a
 * request stands while what was asked for still differs from what is stored, so
 * applying it IS closing it, and so is the client asking for something they
 * already have.
 *
 * Compared as trimmed strings because one side comes from a form and the other
 * from a column that holds both null and "" for the same absence.
 */
export function outstandingIdentityRequests<T extends IdentityRequestRow>(
    rows: T[], current: Record<string, unknown>,
): T[] {
    const norm = (v: unknown) => String(v ?? "").trim();
    const seen = new Set<string>();
    const out: T[] = [];
    for (const row of rows) {
        // Newest first from the query: an older ask for the same field was
        // superseded by the one above it, not granted.
        if (seen.has(row.field)) continue;
        seen.add(row.field);
        if (norm(current[row.field]) === norm(row.new_value)) continue;
        out.push(row);
    }
    return out;
}

/**
 * Group rows by connection, newest bucket order left to the caller.
 *
 * Rows that cannot be attributed land under `null`, which every caller must
 * render rather than drop: a log that quietly hides what it could not file is
 * worse than one that admits it.
 */
export function groupByConnection<T>(
    rows: T[], keyOf: (row: T) => string | null,
): Map<string | null, T[]> {
    const out = new Map<string | null, T[]>();
    for (const row of rows) {
        const key = keyOf(row);
        const list = out.get(key);
        if (list) list.push(row); else out.set(key, [row]);
    }
    return out;
}
