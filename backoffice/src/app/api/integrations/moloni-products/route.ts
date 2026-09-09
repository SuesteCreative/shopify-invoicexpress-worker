import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/account";
import { getMoloniAccessToken, missingMoloniCredentials, moloniBaseUrl } from "@/lib/moloni-token";

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
    let targetUserId = await resolveAccountUser(request, userId);
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
    // An OAuth connection has no username or password by design, so the check
    // has to ask what THIS connection needs. Without this the product-mapping
    // page reported "credentials incomplete" for a Stripe Connect merchant whose
    // Moloni authorisation was perfectly healthy.
    const missing = missingMoloniCredentials(cfg);
    if (missing) return NextResponse.json({ error: missing }, { status: 400 });
    if (!cfg.moloni_company_id) {
        return NextResponse.json({ error: "Moloni credentials incomplete" }, { status: 400 });
    }

    let token: string;
    try {
        token = await getMoloniAccessToken({
            db, userId: authResult.targetUserId, sourceKind, cfg,
        });
    } catch (e: any) {
        // A refresh token that Moloni refused is the merchant's to fix, and 502
        // would send them looking for an outage instead of the authorise button.
        const status = e?.name === "MoloniReauthRequired" ? 400 : 502;
        return NextResponse.json({ error: `Moloni: ${e.message}` }, { status });
    }

    const endpoint = search ? "/products/getBySearch/" : "/products/getAll/";
    const body: Record<string, unknown> = { company_id: Number(cfg.moloni_company_id), qty: limit, offset };
    if (search) body.search = search;

    // Honour the connection's environment rather than hardcoding production —
    // a sandbox connection was silently querying live Moloni.
    const moloniUrl = `${moloniBaseUrl(cfg)}${endpoint}?access_token=${encodeURIComponent(token)}`;
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
