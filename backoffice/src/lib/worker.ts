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
