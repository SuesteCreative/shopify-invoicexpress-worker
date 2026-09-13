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
 *   incidents        — `connection_id` exists in the schema since 0009 and only
 *                      the connection-health check writes it; every other
 *                      reportIncident call site leaves it null. There is no
 *                      function for it here because for most rows there is no
 *                      answer, and guessing one from `kind` would be a guess
 *                      presented as a fact.
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

/**
 * The same, for the account at hand — including a row that names only its source.
 *
 * The dead-letter queue wrote `create_failed` with a source and no destination,
 * and "stripe" even for a Stripe Connect sale. For two accounts those were their
 * only document events, filed under "no connection" while the connection's own
 * filter stayed empty. When exactly ONE of the account's connections takes sales
 * from that source, the row can only be about that one; with two, or none, it
 * stays unattributed rather than guessed.
 */
export function attributeDocumentEvent(row: DocumentEventLike, connectionKeys: readonly string[]): string | null {
    const exact = connectionKeyForDocumentEvent(row);
    if (exact) return exact;
    const source = (row.source_kind ?? "").trim();
    if (!source) return null;
    const family = (kind: string) => (kind === "stripe_connect" ? "stripe" : kind);
    const candidates = [...new Set(connectionKeys)].filter((k) => family(k.split(":")[0]) === family(source));
    return candidates.length === 1 ? candidates[0] : null;
}

/** The three scopes `config_audit` carries for a fiscal identity change. */
export const SCOPE_REQUEST = "profile_change_request";
export const SCOPE_APPLIED = "profile";
export const SCOPE_REJECTED = "profile_change_rejected";

/** The two fields a merchant may ask about and may not edit. */
export const REQUESTABLE_FIELDS = ["nif", "company_name"] as const;

export interface IdentityAuditRow {
    scope: string;
    field: string;
    old_value?: string | null;
    new_value?: string | null;
    created_at: string;
    actor?: string | null;
    [key: string]: unknown;
}

/**
 * Timestamps in `config_audit` and on `users` are written by CURRENT_TIMESTAMP,
 * which SQLite renders as "2026-09-13 08:53:00" — but a value that ever came
 * through code arrives as ISO, and the two sort differently at position 11
 * (`T` > space). Compared normalised rather than raw, for the same reason the
 * document-log purge compares dates only.
 */
function stamp(value: string | null | undefined): string {
    return String(value ?? "").replace("T", " ").replace(/\.\d+Z?$/, "").replace(/Z$/, "").trim();
}

export type IdentityOutcome = "pending" | "applied" | "rejected";

export interface IdentityRequestState {
    field: string;
    /** What the client asked for. */
    requested: string | null;
    requested_at: string;
    outcome: IdentityOutcome;
    /** When it was granted or refused; null while pending. */
    decided_at: string | null;
    /** Who decided, and why they refused — only ever what the operator wrote. */
    decided_by: string | null;
    reason: string | null;
    /**
     * What was actually written, which is NOT always what was asked: an operator
     * correcting a typo in the number the client sent writes their own value.
     * The client is told what their record now says, not what they once asked
     * for. Null when the grant was derived rather than recorded.
     */
    decided_value: string | null;
}

/**
 * What became of each field the client asked about.
 *
 * One row per requestable field, built from the append-only trail rather than
 * from a status column. A decision is any `profile` (granted) or
 * `profile_change_rejected` (refused) row for that field dated at or after the
 * request — which is what lets a client ask AGAIN after a refusal and have the
 * new ask count: it is newer than the refusal, so no decision follows it.
 *
 * A request whose value is already stored counts as granted even with no
 * decision row, because the operator may have changed it from somewhere else
 * (the fiscal console, an onboarding form filled in under impersonation) and the
 * client should not be told their request is still waiting when it plainly is
 * not.
 *
 * `rows` MUST arrive newest-first, and recency is the ORDER OF THE ARRAY, never
 * a comparison of the timestamps in it. `config_audit.created_at` is
 * CURRENT_TIMESTAMP — one-second resolution — so a refusal and a fresh ask in
 * the same second compare equal, and whichever way that tie broke would be a
 * coin flip deciding whether a client's brand new request reads as already
 * refused. The queries order by `created_at DESC, rowid DESC`; insertion order
 * settles it, and this function just trusts what it was handed.
 */
export function identityRequestStates(
    rows: IdentityAuditRow[], current: Record<string, unknown>,
): IdentityRequestState[] {
    const out: IdentityRequestState[] = [];

    for (const field of REQUESTABLE_FIELDS) {
        const mine = rows.filter((r) => r.field === field);
        const at = mine.findIndex((r) => r.scope === SCOPE_REQUEST);
        if (at < 0) continue;
        const latest = mine[at];

        // Anything BEFORE it in the array is newer than it, and the first
        // decision among those is the answer.
        const decision = mine.slice(0, at)
            .find((r) => r.scope === SCOPE_APPLIED || r.scope === SCOPE_REJECTED);

        const granted = String(current[field] ?? "").trim() === String(latest.new_value ?? "").trim();
        const refused = decision?.scope === SCOPE_REJECTED;

        out.push({
            field,
            requested: latest.new_value ?? null,
            requested_at: String(latest.created_at),
            outcome: decision ? (refused ? "rejected" : "applied") : (granted ? "applied" : "pending"),
            decided_at: decision ? String(decision.created_at) : null,
            decided_by: decision?.actor ? String(decision.actor) : null,
            // Only the operator's own words. A refusal with no reason says so
            // rather than inventing one.
            reason: refused ? (decision!.new_value ? String(decision!.new_value) : null) : null,
            decided_value: decision && !refused ? (decision.new_value ?? null) : null,
        });
    }

    return out;
}

/**
 * How far back an unseen answer is still worth announcing.
 *
 * The column arrives null for every account that existed before migration 0059,
 * so without a bound the notice would greet them with a decision from months
 * ago as if it had just happened. An answer nobody has looked at in a month is
 * history, and history lives on the Conta page, which needs no dismissing.
 */
export const IDENTITY_NOTICE_WINDOW_DAYS = 30;

/**
 * The answers the client has not been shown yet.
 *
 * `seenAt` is when they last dismissed the notice (users.identity_notice_seen_at,
 * migration 0059). Null means never — every decision inside the window counts as
 * unread, which is right for a client who has an answer waiting and has never
 * been told.
 *
 * A grant with no decision row is deliberately never announced: it has no date,
 * and a change nobody recorded is a change nobody can honestly say happened
 * today. `now` is passed in rather than read, so the rule is testable.
 */
export function unreadIdentityOutcomes(
    states: IdentityRequestState[], seenAt: string | null | undefined, now: Date = new Date(),
): IdentityRequestState[] {
    const since = stamp(seenAt);
    const cutoff = stamp(new Date(now.getTime() - IDENTITY_NOTICE_WINDOW_DAYS * 864e5).toISOString());

    return states.filter((s) => {
        if (s.outcome === "pending" || !s.decided_at) return false;
        const at = stamp(s.decided_at);
        if (at <= cutoff) return false;
        return !since || at > since;
    });
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
