/**
 * A usable Moloni access token, whichever way the connection authenticates.
 *
 * Two modes exist and they are not interchangeable:
 *
 *   password  the merchant gave us a username and a password, and we mint a
 *             token whenever we need one. Nothing is stored, nothing expires
 *             in a way that matters.
 *   oauth     the merchant authorised us. We hold a rotating pair: an access
 *             token good for an hour and a refresh token good for 14 idle
 *             days that is INVALIDATED every time it is used.
 *
 * The rotation is what makes this more than a fetch. A refresh that is not
 * persisted leaves the connection holding a dead token an hour later, and two
 * refreshes racing on the same stored token leave the loser holding one that
 * Moloni has already killed. Hence the compare-and-swap, which mirrors
 * `src/services/moloni-oauth.ts` in the worker — the two runtimes cannot share
 * code, so they share a shape and this comment instead.
 */

export interface MoloniTokenTarget {
    db: D1Database;
    userId: string;
    sourceKind: string;
    destinationKind?: string;
    /** Parsed destination_config_json. Updated in place after a rotation. */
    cfg: Record<string, any>;
}

const REFRESH_TOKEN_TTL_DAYS = 14;
const ACCESS_TOKEN_SKEW_MS = 5 * 60_000;

export function moloniBaseUrl(cfg: Record<string, any>): string {
    return cfg?.moloni_environment === "sandbox"
        ? "https://apidemo.moloni.pt/v1"
        : "https://api.moloni.pt/v1";
}

export function isMoloniOAuth(cfg: Record<string, any> | null | undefined): boolean {
    return cfg?.moloni_auth_mode === "oauth" || !!cfg?.moloni_refresh_token;
}

/** Raised when only the merchant can fix it, by authorising again. */
export class MoloniReauthRequired extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MoloniReauthRequired";
    }
}

async function passwordGrant(cfg: Record<string, any>): Promise<string> {
    const url = new URL(`${moloniBaseUrl(cfg)}/grant/`);
    url.searchParams.set("grant_type", "password");
    url.searchParams.set("client_id", String(cfg.moloni_client_id));
    url.searchParams.set("client_secret", String(cfg.moloni_client_secret));
    url.searchParams.set("username", String(cfg.moloni_username));
    url.searchParams.set("password", String(cfg.moloni_password));

    const res = await fetch(url.toString(), { method: "POST", headers: { Accept: "application/json" } });
    const body = await res.json().catch(() => null) as { access_token?: string } | null;
    if (!res.ok || !body?.access_token) throw new Error(`Moloni OAuth failed: ${res.status}`);
    return body.access_token;
}

async function refreshGrant(target: MoloniTokenTarget): Promise<string> {
    const { cfg } = target;
    const previous = String(cfg.moloni_refresh_token ?? "");
    if (!previous) {
        throw new MoloniReauthRequired("A ligação ao Moloni não está autorizada. Autorize outra vez no assistente.");
    }

    const url = new URL(`${moloniBaseUrl(cfg)}/grant/`);
    url.searchParams.set("grant_type", "refresh_token");
    url.searchParams.set("client_id", String(cfg.moloni_client_id));
    url.searchParams.set("client_secret", String(cfg.moloni_client_secret));
    url.searchParams.set("refresh_token", previous);

    const res = await fetch(url.toString(), { method: "POST", headers: { Accept: "application/json" } });
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* Moloni sometimes answers HTML on error */ }

    if (!res.ok) {
        const detail = String(body?.error_description ?? body?.error ?? text).slice(0, 200);
        // 400/401 means the token is spent, revoked or 14 days stale. No retry
        // fixes that; only the merchant can, by authorising again.
        if (res.status === 400 || res.status === 401) {
            throw new MoloniReauthRequired(`O Moloni recusou a autorização (${res.status}). Autorize outra vez no assistente.`);
        }
        throw new Error(`Moloni refresh failed (${res.status}): ${detail}`);
    }

    const accessToken = String(body?.access_token ?? "");
    const refreshToken = String(body?.refresh_token ?? "");
    if (!accessToken || !refreshToken) throw new Error("Moloni refresh returned an incomplete token pair");

    const now = Date.now();
    const expiresIn = Number(body?.expires_in ?? 3600);
    const patch = {
        moloni_auth_mode: "oauth",
        moloni_access_token: accessToken,
        moloni_refresh_token: refreshToken,
        moloni_token_expires_at: new Date(now + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000).toISOString(),
        moloni_refresh_expires_at: new Date(now + REFRESH_TOKEN_TTL_DAYS * 86_400_000).toISOString(),
    };

    // Compare-and-swap on the token we started from. If the worker rotated first
    // this changes nothing, and the reload below picks up whatever it stored.
    const written: any = await target.db.prepare(
        `UPDATE connections
            SET destination_config_json = json_patch(COALESCE(destination_config_json, '{}'), ?),
                last_token_refresh_at = ?, updated_at = ?
          WHERE user_id = ? AND source_kind = ? AND destination_kind = ?
            AND json_extract(destination_config_json, '$.moloni_refresh_token') = ?`
    ).bind(
        JSON.stringify(patch), new Date(now).toISOString(), new Date(now).toISOString(),
        target.userId, target.sourceKind, target.destinationKind ?? "moloni", previous,
    ).run();

    if ((written?.meta?.changes ?? 0) === 0) {
        const row: any = await target.db.prepare(
            `SELECT destination_config_json FROM connections
              WHERE user_id = ? AND source_kind = ? AND destination_kind = ? LIMIT 1`
        ).bind(target.userId, target.sourceKind, target.destinationKind ?? "moloni").first();
        try {
            const current = JSON.parse(row?.destination_config_json ?? "{}");
            if (current?.moloni_access_token) {
                Object.assign(cfg, current);
                return String(current.moloni_access_token);
            }
        } catch { /* fall through and use the pair we just minted */ }
    }

    Object.assign(cfg, patch);
    return accessToken;
}

export async function getMoloniAccessToken(target: MoloniTokenTarget): Promise<string> {
    const { cfg } = target;

    if (!isMoloniOAuth(cfg)) return passwordGrant(cfg);

    const stored = String(cfg.moloni_access_token ?? "");
    const expiresAt = Date.parse(String(cfg.moloni_token_expires_at ?? ""));
    if (stored && Number.isFinite(expiresAt) && expiresAt - ACCESS_TOKEN_SKEW_MS > Date.now()) {
        return stored;
    }
    return refreshGrant(target);
}

/** What is missing before this connection can talk to Moloni at all, if anything. */
export function missingMoloniCredentials(cfg: Record<string, any>): string | null {
    if (!cfg.moloni_client_id || !cfg.moloni_client_secret) return "Moloni credentials incomplete";
    if (isMoloniOAuth(cfg)) {
        return cfg.moloni_refresh_token ? null : "A ligação ao Moloni não está autorizada";
    }
    if (!cfg.moloni_username || !cfg.moloni_password) return "Moloni credentials incomplete";
    return null;
}
