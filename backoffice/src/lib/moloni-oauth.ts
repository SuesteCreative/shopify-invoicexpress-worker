import { RIOKO_CONFIG } from "@/lib/config";

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

export type MoloniConnectionRow = {
    id: string;
    destination_config_json?: string | null;
    source_config_json?: string | null;
};

/**
 * The connection this code belongs to.
 *
 * `state` names it outright when Moloni echoes the parameter back. When it does
 * not, the merchant's own pending authorisation is the answer: the start route
 * writes a state with a fifteen minute life on the row it is about to send them
 * away from, so a row still holding a live one is a round trip in flight. The
 * most recent wins, which is the one they just started.
 */
export async function findPendingMoloniConnection(
    db: any,
    targetUserId: string,
    state: string | null,
): Promise<MoloniConnectionRow | null> {
    const now = new Date().toISOString();
    if (state) {
        const byState = await db
            .prepare(`SELECT id, destination_config_json, source_config_json FROM connections
                       WHERE user_id = ? AND oauth_state = ? AND oauth_state_expires_at > ?
                       LIMIT 1`)
            .bind(targetUserId, state, now)
            .first();
        if (byState) return byState as MoloniConnectionRow;
    }
    const pending = await db
        .prepare(`SELECT id, destination_config_json, source_config_json FROM connections
                   WHERE user_id = ? AND destination_kind = 'moloni'
                     AND oauth_state IS NOT NULL AND oauth_state_expires_at > ?
                   ORDER BY updated_at DESC LIMIT 1`)
        .bind(targetUserId, now)
        .first();
    return (pending as MoloniConnectionRow) ?? null;
}

export type MoloniExchange = { ok: true } | { ok: false; detail: string };

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
    const clientId = cfg.moloni_client_id;
    const clientSecret = cfg.moloni_client_secret;
    if (!clientId || !clientSecret) {
        return { ok: false, detail: "Faltam as credenciais da aplicação Moloni. Recomece o passo do Moloni." };
    }

    const baseUrl = cfg.moloni_environment === "sandbox"
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
            moloni_access_token: accessToken,
            moloni_refresh_token: refreshToken,
            moloni_token_expires_at: new Date(now + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000).toISOString(),
            moloni_refresh_expires_at: new Date(now + REFRESH_TOKEN_TTL_DAYS * 86_400_000).toISOString(),
            moloni_oauth_error: null,
        }),
        new Date(now).toISOString(), new Date(now).toISOString(), row.id,
    ).run();

    return { ok: true };
}
