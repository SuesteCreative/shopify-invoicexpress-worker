import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getImpersonationId } from "@/lib/admin";

export const runtime = "edge";

/**
 * Proxy: list Moloni products for the user's mapped Moloni account.
 *
 * The user's Moloni credentials live in `connections.destination_config_json`
 * (destination_kind='moloni'). We mint a short-lived OAuth token here and
 * call `/products/getAll/`. Returns the redacted product summary the mapping
 * UI needs (id, reference, name, price).
 */

async function resolveTargetUser(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return { error: "Unauthorized", status: 401 as const };
    let targetUserId = userId;
    if (await isAdmin(userId)) {
        const impersonationId = await getImpersonationId(request);
        if (impersonationId) targetUserId = impersonationId;
    }
    return { userId, targetUserId };
}

function formEncode(obj: Record<string, unknown>, prefix = ""): string {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
        if (v === undefined || v === null) continue;
        const key = prefix ? `${prefix}[${k}]` : k;
        if (Array.isArray(v)) {
            v.forEach((item, i) => {
                const idxKey = `${key}[${i}]`;
                if (item !== null && typeof item === "object") {
                    parts.push(formEncode(item as Record<string, unknown>, idxKey));
                } else {
                    parts.push(`${encodeURIComponent(idxKey)}=${encodeURIComponent(String(item))}`);
                }
            });
        } else if (typeof v === "object") {
            parts.push(formEncode(v as Record<string, unknown>, key));
        } else {
            parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
        }
    }
    return parts.filter(Boolean).join("&");
}

async function moloniOAuth(cfg: any): Promise<string> {
    const url = new URL("https://api.moloni.pt/v1/grant/");
    url.searchParams.set("grant_type", "password");
    url.searchParams.set("client_id", String(cfg.moloni_client_id));
    url.searchParams.set("client_secret", String(cfg.moloni_client_secret));
    url.searchParams.set("username", String(cfg.moloni_username));
    url.searchParams.set("password", String(cfg.moloni_password));
    const res = await fetch(url.toString(), { method: "POST" });
    const body = await res.json() as { access_token?: string };
    if (!res.ok || !body.access_token) {
        throw new Error(`Moloni OAuth failed: ${res.status}`);
    }
    return body.access_token;
}

export async function GET(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const url = new URL(request.url);
    const sourceKind = url.searchParams.get("source_kind") ?? "shopify";
    const search = url.searchParams.get("search")?.trim();
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 200);

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    const conn: any = await db.prepare(
        `SELECT destination_config_json FROM connections
         WHERE user_id = ? AND source_kind = ? AND destination_kind = 'moloni' LIMIT 1`,
    ).bind(authResult.targetUserId, sourceKind).first();
    if (!conn?.destination_config_json) {
        return NextResponse.json({ error: "Moloni connection not configured" }, { status: 400 });
    }
    const cfg = JSON.parse(conn.destination_config_json);
    if (!cfg.moloni_client_id || !cfg.moloni_client_secret || !cfg.moloni_username || !cfg.moloni_password || !cfg.moloni_company_id) {
        return NextResponse.json({ error: "Moloni credentials incomplete" }, { status: 400 });
    }

    let token: string;
    try {
        token = await moloniOAuth(cfg);
    } catch (e: any) {
        return NextResponse.json({ error: `Moloni OAuth: ${e.message}` }, { status: 502 });
    }

    const endpoint = search ? "/products/getBySearch/" : "/products/getAll/";
    const body: Record<string, unknown> = { company_id: Number(cfg.moloni_company_id), qty: limit, offset };
    if (search) body.search = search;

    const moloniUrl = `https://api.moloni.pt/v1${endpoint}?access_token=${encodeURIComponent(token)}`;
    const res = await fetch(moloniUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
        body: formEncode(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !Array.isArray(data)) {
        return NextResponse.json({ error: "Moloni products fetch failed", detail: data }, { status: 502 });
    }

    const products = data.map((p: any) => ({
        product_id: Number(p.product_id),
        reference: p.reference ?? "",
        name: p.name ?? "",
        price: Number(p.price ?? 0),
        category_id: p.category_id,
        unit_id: p.unit_id,
    }));

    return NextResponse.json({ products });
}
