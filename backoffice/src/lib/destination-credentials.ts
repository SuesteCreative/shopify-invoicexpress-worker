import { isMoloniOAuth } from "./moloni-token";

/**
 * Both halves of an InvoiceXpress credential, present and non-blank.
 *
 * One rule, three readers: the activation guard below, and the GET and POST of
 * /api/integrations, which use it to decide whether the stored `ix_authorized`
 * verdict still stands. It is a verdict about a key that was tested once, and
 * nothing withdrew it when the key was later cleared.
 */
export function ixCredentialsPresent(row: { ix_account_name?: unknown; ix_api_key?: unknown } | null | undefined): boolean {
    return !!String(row?.ix_account_name ?? "").trim() && !!String(row?.ix_api_key ?? "").trim();
}

/**
 * Can this connection actually reach its destination?
 *
 * Every wizard is an accordion of independent steps, and only the SOURCE half
 * was ever checked before a connection was allowed to go active ("api_key is
 * required to activate", "hmac_secret is required for active status"). Nothing
 * asked the same question of the destination, so a merchant who skipped the
 * InvoiceXpress step — or came back and cleared it — got an ACTIVE connection,
 * a paid subscription and a dashboard that said everything was fine, while
 * every payment failed at the proxy with `x-account-name and x-api-key are
 * required` and no document was ever issued.
 *
 * Measured on 2026-09-12: three live accounts in that state, one of which had
 * been silently issuing nothing since the day it onboarded.
 *
 * Returns null when the credentials are present, or the sentence to answer the
 * activation with when they are not.
 */
export async function missingDestinationCredentials(
    db: D1Database,
    userId: string,
    sourceKind: string,
    destinationKind: string,
): Promise<string | null> {
    if (destinationKind === "invoicexpress") {
        // IX credentials live on the legacy `integrations` row, one per account,
        // shared by every connection that files into that IX account.
        const row: any = await db
            .prepare("SELECT ix_account_name, ix_api_key FROM integrations WHERE user_id = ?")
            .bind(userId)
            .first();
        if (ixCredentialsPresent(row)) return null;
        return "Connect InvoiceXpress before activating: the account name and API key are missing, and without them no document can be issued.";
    }

    if (destinationKind === "moloni" || destinationKind === "vendus") {
        // Both keep their credentials in the connection's own destination_config.
        const row: any = await db
            .prepare(
                `SELECT destination_config_json FROM connections
                  WHERE user_id = ? AND source_kind = ? AND destination_kind = ?`
            )
            .bind(userId, sourceKind, destinationKind)
            .first();
        let cfg: Record<string, any> = {};
        try { cfg = row?.destination_config_json ? JSON.parse(row.destination_config_json) : {}; } catch { cfg = {}; }

        if (destinationKind === "vendus") {
            return String(cfg.vendus_api_key ?? "").trim()
                ? null
                : "Connect Vendus before activating: the API key is missing, and without it no document can be issued.";
        }
        const legacyPair = !!String(cfg.moloni_client_id ?? "").trim() && !!String(cfg.moloni_username ?? "").trim();
        return isMoloniOAuth(cfg) || legacyPair
            ? null
            : "Connect Moloni before activating: the authorisation is missing, and without it no document can be issued.";
    }

    // An unknown destination is not something this can judge, and refusing it
    // would break a wizard that ships before this file is updated.
    return null;
}
