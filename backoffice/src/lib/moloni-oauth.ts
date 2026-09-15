import { RIOKO_CONFIG } from "./config";
import { listMoloniCompanies, type MoloniNamedId } from "./moloni-token";

/**
 * The Moloni OAuth round trip, in one place.
 *
 * The callback URL used to carry the connection id, one per connection, so the
 * callback never had to guess whose code it was holding. It cost more than it
 * bought: a Moloni developer app holds exactly ONE callback URL, so a merchant
 * with a second connection — or one who set the integration up again after
 * deleting it — was handed a URL their app did not have, and Moloni answered
 * "os dados de acesso são inválidos ou o redirect_uri não coincide" before the
 * consent screen ever appeared. Nothing on our side was wrong, and there was
 * nothing the merchant could have pasted differently.
 *
 * So the URL is now the same for everybody and never changes. Which connection
 * a code belongs to is decided here instead, from the session plus the one-shot
 * state the start route wrote on the row — the same nonce that was already the
 * CSRF guard.
 */

export const MOLONI_CALLBACK_PATH = "/api/integrations/moloni-oauth/callback";

/** The one URL a merchant registers in their Moloni developer app. */
export function moloniCallbackUri(): string {
    return `${RIOKO_CONFIG.appUrl}${MOLONI_CALLBACK_PATH}`;
}

const REFRESH_TOKEN_TTL_DAYS = 14;

/**
 * How long a Moloni round trip counts as in flight.
 *
 * Matches the fifteen minutes the shared OAuth state has always used. The
 * marker lives on the connection rather than in that column, so it needs its own
 * expiry: a merchant who starts an authorisation and closes the tab must not
 * leave the account looking busy forever.
 */
const PENDING_TTL_MS = 15 * 60 * 1000;

export type MoloniConnectionRow = {
    id: string;
    /** Whose connection this is: the callback's kill-switch check needs it. */
    source_kind?: string | null;
    destination_config_json?: string | null;
    source_config_json?: string | null;
};

/**
 * The connection this code belongs to.
 *
 * `state` names it outright when Moloni echoes the parameter back. It does not,
 * in practice — so what actually answers is the marker the start route writes on
 * the row it is about to send the merchant away from, and which it clears on
 * that account's other Moloni connections first. One in flight at a time, by
 * construction.
 */
export async function findPendingMoloniConnection(
    db: any,
    targetUserId: string,
    state: string | null,
): Promise<MoloniConnectionRow | null> {
    const now = new Date().toISOString();
    if (state) {
        const byState = await db
            .prepare(`SELECT id, source_kind, destination_config_json, source_config_json FROM connections
                       WHERE user_id = ? AND oauth_state = ? AND oauth_state_expires_at > ?
                       LIMIT 1`)
            .bind(targetUserId, state, now)
            .first();
        if (byState) return byState as MoloniConnectionRow;
    }
    // `moloni_oauth_pending_at`, not the shared `oauth_state` column.
    //
    // That column is the Stripe Connect round trip's too, and on a
    // `stripe_connect → moloni` connection both flows write it to the SAME row.
    // Reading it here counted a Stripe authorisation in flight as a Moloni one,
    // which with the guard below turned somebody else's round trip into a hard
    // refusal of this one.
    //
    // The start route clears this marker on the account's other Moloni
    // connections before setting its own, so there is only ever one in flight
    // and the guard below is a net rather than a normal outcome.
    const cutoff = new Date(Date.now() - PENDING_TTL_MS).toISOString();
    const pending = await db
        .prepare(`SELECT id, source_kind, destination_config_json, source_config_json FROM connections
                   WHERE user_id = ? AND destination_kind = 'moloni'
                     AND json_extract(destination_config_json, '$.moloni_oauth_pending_at') > ?
                   ORDER BY json_extract(destination_config_json, '$.moloni_oauth_pending_at') DESC
                   LIMIT 2`)
        .bind(targetUserId, cutoff)
        .all();

    const rows = (pending?.results ?? []) as MoloniConnectionRow[];
    // Two in flight at once is genuinely ambiguous, and the wrong answer writes
    // a Moloni access and refresh token pair onto a connection the merchant was
    // not authorising — which then files that integration's documents into
    // another company.
    //
    // Refusing costs the merchant a retry. Guessing costs a document in the
    // wrong company, and nothing would say so.
    if (rows.length > 1) {
        console.warn(`[moloni-oauth] ${targetUserId}: ${rows.length} Moloni authorisations pending at once and Moloni echoed no state; refusing to choose`);
        return null;
    }
    return rows[0] ?? null;
}

export type MoloniExchange = { ok: true } | { ok: false; detail: string };

/**
 * A migration that must not go through: record why, touch nothing else.
 *
 * The round trip is over either way, so the pending marker is cleared — left
 * standing it would make the merchant's next attempt read as ambiguous. The
 * password, the app and the auth mode stay exactly as they were.
 */
async function refuseMigration(db: any, id: string, detail: string): Promise<MoloniExchange> {
    await db.prepare(
        `UPDATE connections
            SET destination_config_json = json_patch(COALESCE(destination_config_json, '{}'), ?),
                oauth_state = NULL, oauth_state_expires_at = NULL, updated_at = ?
          WHERE id = ?`
    ).bind(
        JSON.stringify({ moloni_oauth_error: detail.slice(0, 300), moloni_oauth_pending_at: null }),
        new Date().toISOString(), id,
    ).run();
    return { ok: false, detail };
}

/**
 * Trades the one-time code for a token pair and stores it on the connection.
 *
 * `redirectUri` has to be the same string the authorisation was started with,
 * or Moloni refuses the exchange — which is why it is passed in rather than
 * rebuilt here: the legacy per-connection callback still answers for apps that
 * were registered with it.
 */
export async function exchangeMoloniCode(
    db: any,
    row: MoloniConnectionRow,
    code: string,
    redirectUri: string,
): Promise<MoloniExchange> {
    const cfg = row.destination_config_json ? JSON.parse(row.destination_config_json) : {};
    // A connection moving off a password keeps its old app in place until this
    // exchange succeeds — see the start route — so the app being authorised is
    // the pending one when there is one.
    const clientId = cfg.moloni_pending_client_id ?? cfg.moloni_client_id;
    const clientSecret = cfg.moloni_pending_client_secret ?? cfg.moloni_client_secret;
    const environment = cfg.moloni_pending_environment ?? cfg.moloni_environment;
    if (!clientId || !clientSecret) {
        return { ok: false, detail: "Faltam as credenciais da aplicação Moloni. Recomece o passo do Moloni." };
    }

    const baseUrl = environment === "sandbox"
        ? "https://apidemo.moloni.pt/v1"
        : "https://api.moloni.pt/v1";

    const grantUrl = new URL(`${baseUrl}/grant/`);
    grantUrl.searchParams.set("grant_type", "authorization_code");
    grantUrl.searchParams.set("client_id", clientId);
    grantUrl.searchParams.set("client_secret", clientSecret);
    grantUrl.searchParams.set("redirect_uri", redirectUri);
    grantUrl.searchParams.set("code", code);

    let body: any;
    try {
        const res = await fetch(grantUrl.toString(), {
            method: "POST",
            headers: { "Accept": "application/json" },
        });
        const text = await res.text();
        try { body = JSON.parse(text); } catch { body = null; }
        if (!res.ok) {
            return { ok: false, detail: String(body?.error_description ?? body?.error ?? `Moloni ${res.status}`) };
        }
    } catch (e: any) {
        return { ok: false, detail: `Não foi possível falar com o Moloni: ${e?.message ?? e}` };
    }

    const accessToken = body?.access_token;
    const refreshToken = body?.refresh_token;
    if (!accessToken || !refreshToken) {
        // An access token with no refresh token would work for one hour and then
        // strand the connection with no way back.
        return { ok: false, detail: "O Moloni não devolveu um refresh token." };
    }

    // Migrating off a password: prove the account that just authorised is the one
    // this connection invoices into, BEFORE the credential it replaces is gone.
    //
    // A merchant with two Moloni logins — their own and a client's, or a personal
    // one beside the company's — picks the wrong one on the consent screen and
    // Moloni answers with a perfectly valid token pair for the wrong account.
    // Written through, that leaves a working connection authenticated against an
    // account that cannot see its company, with the password already deleted.
    //
    // Fails closed: anything short of a match leaves the connection exactly as it
    // is, still invoicing on its password.
    const migrating = !!cfg.moloni_password && !cfg.moloni_refresh_token;
    const wantedId = Number(cfg.moloni_company_id ?? 0);
    const wantedName = String(cfg.moloni_company_name ?? "").trim().toLowerCase();
    if (migrating && (wantedId || wantedName)) {
        let seen: MoloniNamedId[];
        try {
            seen = await listMoloniCompanies({ moloni_environment: environment }, accessToken);
        } catch (e: any) {
            return refuseMigration(db, row.id, `Não foi possível confirmar no Moloni a empresa desta ligação: ${e?.message ?? e}. Nada foi alterado; tente autorizar outra vez.`);
        }
        const match = seen.some((c) => (wantedId
            ? c.id === wantedId
            : c.name.trim().toLowerCase() === wantedName));
        if (!match) {
            return refuseMigration(db, row.id, `A conta Moloni autorizada não tem acesso a "${cfg.moloni_company_name || wantedId}". A ligação continua a facturar como estava — autorize com a conta Moloni dessa empresa.`);
        }
    }

    const now = Date.now();
    const expiresIn = Number(body?.expires_in ?? 3600);
    await db.prepare(
        `UPDATE connections
            SET destination_config_json = json_patch(COALESCE(destination_config_json, '{}'), ?),
                oauth_state = NULL, oauth_state_expires_at = NULL,
                last_token_refresh_at = ?, updated_at = ?
          WHERE id = ?`
    ).bind(
        JSON.stringify({
            moloni_auth_mode: "oauth",
            moloni_client_id: clientId,
            moloni_client_secret: clientSecret,
            ...(environment ? { moloni_environment: environment } : {}),
            moloni_pending_client_id: null,
            moloni_pending_client_secret: null,
            moloni_pending_environment: null,
            // The password grant is over for this connection. Kept, it would be a
            // live Moloni login sitting in a row that nothing reads any more.
            moloni_username: null,
            moloni_password: null,
            moloni_access_token: accessToken,
            moloni_refresh_token: refreshToken,
            moloni_token_expires_at: new Date(now + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000).toISOString(),
            moloni_refresh_expires_at: new Date(now + REFRESH_TOKEN_TTL_DAYS * 86_400_000).toISOString(),
            moloni_oauth_error: null,
            // The round trip is over. Left standing, it would keep this
            // connection looking in flight for the rest of its fifteen minutes
            // and make the next authorisation on the account read as ambiguous.
            moloni_oauth_pending_at: null,
        }),
        new Date(now).toISOString(), new Date(now).toISOString(), row.id,
    ).run();

    return { ok: true };
}
