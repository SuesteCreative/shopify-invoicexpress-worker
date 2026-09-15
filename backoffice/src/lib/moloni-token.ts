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

export type MoloniConnectionToken =
    | { ok: true; cfg: Record<string, any>; token: string }
    | { ok: false; status: number; error: string };

/**
 * One connection's stored Moloni config, and a token to call Moloni with.
 *
 * Every route that reads from Moloni needs exactly this, and four of them used to
 * do it by hand: pull the username and password out of the row and either run a
 * password grant or post them to a worker proxy that only knows that grant. Since
 * 15/09/2026 every new Moloni connection authorises by OAuth and has no password
 * at all, so each of those routes could only fail for it — the tag-routing page
 * was already showing a Stripe Connect merchant an empty list of séries.
 *
 * This asks the connection how it authenticates instead of assuming. The nine
 * connections that still use a username and password keep working unchanged.
 */
export async function moloniConnectionToken(
    db: D1Database,
    userId: string,
    sourceKind: string,
): Promise<MoloniConnectionToken> {
    const row: any = await db.prepare(
        `SELECT destination_config_json FROM connections
          WHERE user_id = ? AND source_kind = ? AND destination_kind = 'moloni' LIMIT 1`
    ).bind(userId, sourceKind).first();
    if (!row?.destination_config_json) {
        return { ok: false, status: 404, error: "Ligação Moloni não encontrada. Autorize o Moloni primeiro." };
    }

    let cfg: Record<string, any>;
    try { cfg = JSON.parse(row.destination_config_json); } catch {
        return { ok: false, status: 500, error: "A configuração Moloni guardada está corrompida." };
    }

    const missing = missingMoloniCredentials(cfg);
    if (missing) return { ok: false, status: 400, error: missing };

    try {
        const token = await getMoloniAccessToken({ db, userId, sourceKind, destinationKind: "moloni", cfg });
        return { ok: true, cfg, token };
    } catch (e: any) {
        // A refused refresh token is the merchant's to fix. 502 would send them
        // looking for an outage instead of the authorise button.
        const status = e?.name === "MoloniReauthRequired" ? 400 : 502;
        return { ok: false, status, error: `Moloni: ${e?.message ?? e}` };
    }
}

export interface MoloniNamedId {
    id: number;
    name: string;
}

/** The companies this token can see. `companies/getAll` wants a POST with no body. */
export async function listMoloniCompanies(cfg: Record<string, any>, token: string): Promise<MoloniNamedId[]> {
    const res = await fetch(
        `${moloniBaseUrl(cfg)}/companies/getAll/?access_token=${encodeURIComponent(token)}&json=true`,
        { method: "POST", headers: { Accept: "application/json" } },
    );
    if (!res.ok) throw new Error(`Moloni companies lookup failed (${res.status})`);
    const data: unknown = await res.json().catch(() => null);
    if (!Array.isArray(data)) return [];
    return data
        .map((c: any) => ({ id: Number(c.company_id ?? c.id ?? 0), name: String(c.name ?? c.company_name ?? "") }))
        .filter((c) => c.id > 0 && c.name);
}

/** One company's document sets. `documentSets/getAll` ignores a form body; it wants JSON. */
export async function listMoloniDocumentSets(
    cfg: Record<string, any>,
    token: string,
    companyId: number,
): Promise<MoloniNamedId[]> {
    const res = await fetch(
        `${moloniBaseUrl(cfg)}/documentSets/getAll/?access_token=${encodeURIComponent(token)}&json=true`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ company_id: companyId }),
        },
    );
    if (!res.ok) throw new Error(`Moloni document-set lookup failed (${res.status})`);
    const data: unknown = await res.json().catch(() => null);
    if (!Array.isArray(data)) return [];
    return data
        .map((d: any) => ({ id: Number(d.document_set_id ?? d.id ?? 0), name: String(d.name ?? d.document_set_name ?? "") }))
        .filter((d) => d.id > 0 && d.name);
}
