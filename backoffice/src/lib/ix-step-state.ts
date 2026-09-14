/**
 * What the InvoiceXpress step of a wizard should show, given both places a
 * credential can live.
 *
 * There are two, and only one of them is ever the truth for a given account:
 * the legacy `integrations` row — the Shopify pair, and every setup made before
 * a connection could hold credentials of its own — and the connection's
 * `destination_config_json`, which is what the worker reads for a non-Shopify
 * source.
 *
 * Each wizard used to answer this for itself, in its own load effect, and they
 * did not agree. Lodgify and EuPago took `has_ix_credentials` from the
 * connection to decide which step to open, then took `ix_authorized` from the
 * legacy row to draw the badge. An account whose key lives only on the
 * connection has no verdict on that row, so the badge read "pendente" and the
 * completion card stayed red while the connection was issuing documents
 * normally. Measured 2026-09-14 on Farracemota Unipessoal, who reasonably
 * concluded their API key had not been saved and typed it again.
 *
 * A merchant reads the badge as the answer to "is this working". It has to come
 * from the same place the worker looks, and it has to come from one place in
 * this codebase — here.
 */

/** The account's legacy row, as `/api/integrations` reports it (no secrets). */
export type LegacyIxRow = {
    ix_account_name?: unknown;
    has_ix_api_key?: unknown;
    ix_authorized?: unknown;
} | null | undefined;

/** A connection, as its own `*-source` route reports it (no secrets). */
export type ConnectionIx = {
    has_ix_credentials?: unknown;
    ix_account_name?: unknown;
} | null | undefined;

export type IxStepState = {
    /** What to show in the account-name field. */
    accountName: string;
    /** A key is stored, so a blank field means "keep it". */
    keyStored: boolean;
    /** Whether the step is done, and the badge green. */
    authorized: boolean;
};

export function ixStepState(legacy: LegacyIxRow, connection: ConnectionIx): IxStepState {
    const onConnection = !!connection?.has_ix_credentials;
    const text = (v: unknown) => String(v ?? "").trim();

    return {
        // The connection's name wins: it is the one the worker will call.
        accountName: text(connection?.ix_account_name) || text(legacy?.ix_account_name),
        keyStored: onConnection || !!legacy?.has_ix_api_key,
        // Credentials held by the connection answer for themselves. The legacy
        // verdict only ever spoke about the legacy pair, and it stands only
        // while that pair is still there — `/api/integrations` already withdraws
        // it when either half goes missing, and this does not restore it.
        authorized: onConnection || (Number(legacy?.ix_authorized) === 1 && !!legacy?.has_ix_api_key),
    };
}
