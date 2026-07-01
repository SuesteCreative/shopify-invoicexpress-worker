import { RIOKO_CONFIG } from "./config";
import { getRequestContext } from "@cloudflare/next-on-pages";

function getEnv(): { workerUrl: string; adminApiKey: string } {
    const ctx = (() => { try { return getRequestContext(); } catch { return null; } })();
    const env = (ctx?.env ?? {}) as any;
    return {
        workerUrl: env.WORKER_URL || process.env.WORKER_URL || RIOKO_CONFIG.workerUrl,
        adminApiKey: env.ADMIN_API_KEY || process.env.ADMIN_API_KEY || "",
    };
}

export async function callWorker(path: string, init: RequestInit = {}): Promise<Response> {
    const { workerUrl, adminApiKey } = getEnv();
    if (!adminApiKey) {
        return new Response(JSON.stringify({ error: "ADMIN_API_KEY not configured" }), { status: 500 });
    }
    const url = `${workerUrl.replace(/\/$/, "")}${path}`;
    const headers = new Headers(init.headers);
    headers.set("x-api-key", adminApiKey);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    return fetch(url, { ...init, headers });
}

export async function callWorkerJson<T = any>(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: T | { error: string } }> {
    const res = await callWorker(path, init);
    let data: any;
    try { data = await res.json(); } catch { data = { error: await res.text() }; }
    return { ok: res.ok, status: res.status, data };
}

export async function resolveShopForUser(userId: string): Promise<string | null> {
    const ctx = (() => { try { return getRequestContext(); } catch { return null; } })();
    const db = (ctx?.env as any)?.DB;
    if (!db) return null;
    const row: any = await db.prepare("SELECT shopify_domain FROM integrations WHERE user_id = ?").bind(userId).first();
    return row?.shopify_domain ?? null;
}

/** Impersonation-aware: returns the shop for whoever is currently viewing
 *  (impersonated user when admin is impersonating, else the auth user). */
export async function resolveSelfShop(request: Request, fallbackUserId: string): Promise<string | null> {
    return resolveShopForUser(resolveViewerId(request, fallbackUserId));
}

/** Impersonation-aware viewer id (impersonated user when an admin is
 *  impersonating, else the authenticated user). */
export function resolveViewerId(request: Request, fallbackUserId: string): string {
    const cookieHeader = request.headers.get("cookie") ?? "";
    const m = cookieHeader.match(/rioko_impersonate_id=([^;]+)/);
    return m ? m[1] : fallbackUserId;
}

export type ConnectionSummary = {
    source: string;        // "shopify" | "lodgify" | "stripe" | …
    destination: string;   // "invoicexpress" | "moloni" | "vendus"
    identifier: string;    // shop domain for Shopify, else the user id
};

/** Resolve which integration a user reconciles: the active `connections` row
 *  (source→destination), falling back to a legacy Shopify `integrations` row.
 *  Drives the dynamic conciliação title/labels. Returns null when neither exists. */
export async function resolveConnectionForUser(userId: string): Promise<ConnectionSummary | null> {
    const ctx = (() => { try { return getRequestContext(); } catch { return null; } })();
    const db = (ctx?.env as any)?.DB;
    if (!db) return null;

    const conn: any = await db.prepare(
        `SELECT source_kind, destination_kind FROM connections
         WHERE user_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1`
    ).bind(userId).first();

    const domRow: any = await db.prepare("SELECT shopify_domain FROM integrations WHERE user_id = ?").bind(userId).first();
    const domain: string | null = domRow?.shopify_domain ?? null;

    if (conn) {
        const identifier = conn.source_kind === "shopify" && domain ? domain : userId;
        return { source: conn.source_kind, destination: conn.destination_kind, identifier };
    }
    if (domain) return { source: "shopify", destination: "invoicexpress", identifier: domain };
    return null;
}
