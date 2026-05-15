const WORKER_URL = process.env.WORKER_URL ?? "https://shopify-invoicexpress-worker.pedrotovarporto.workers.dev";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY ?? "";

export async function callWorker(path: string, init: RequestInit = {}): Promise<Response> {
    if (!ADMIN_API_KEY) {
        return new Response(JSON.stringify({ error: "ADMIN_API_KEY not configured" }), { status: 500 });
    }
    const url = `${WORKER_URL.replace(/\/$/, "")}${path}`;
    const headers = new Headers(init.headers);
    headers.set("x-api-key", ADMIN_API_KEY);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    return fetch(url, { ...init, headers });
}

export async function callWorkerJson<T = any>(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: T | { error: string } }> {
    const res = await callWorker(path, init);
    let data: any;
    try { data = await res.json(); } catch { data = { error: await res.text() }; }
    return { ok: res.ok, status: res.status, data };
}

export async function resolveShopForCurrentUser(userId: string): Promise<string | null> {
    const { ok, data } = await callWorkerJson<{ shopify_domain: string | null }>(`/admin/user-shop?user_id=${encodeURIComponent(userId)}`);
    if (!ok) return null;
    return (data as any).shopify_domain ?? null;
}
