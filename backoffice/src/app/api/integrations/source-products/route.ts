import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getImpersonationId } from "@/lib/admin";

export const runtime = "edge";

/**
 * Proxy: list source-side products (Shopify variants or Stripe prices) for the
 * mapping UI. Returns normalized rows with the SAME `source_reference` shape
 * the worker's `deriveProductReference()` produces — so the UI can pair them
 * directly against `product_mappings.source_reference`.
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

type SourceProduct = {
    source_reference: string;        // matches adapter's deriveProductReference()
    source_product_id: string | null;
    source_variant_id: string | null;
    source_sku: string | null;
    title: string;
    variant_title: string | null;
    price: number;
};

async function listShopify(domain: string, token: string, apiVersion: string): Promise<SourceProduct[]> {
    const out: SourceProduct[] = [];
    const url = `https://${domain}/admin/api/${apiVersion}/products.json?limit=100`;
    const res = await fetch(url, {
        headers: { "X-Shopify-Access-Token": token, "Accept": "application/json" },
    });
    if (!res.ok) throw new Error(`Shopify ${res.status}: ${await res.text().catch(() => "")}`);
    const json = await res.json() as { products?: any[] };
    for (const p of json.products ?? []) {
        for (const v of p.variants ?? []) {
            const sku = (v.sku ?? "").trim();
            const reference = sku
                ? sku.slice(0, 30)
                : v.id
                    ? `RIOKO-VARIANT-${v.id}`.slice(0, 30)
                    : `RIOKO-PRODUCT-${p.id}`.slice(0, 30);
            out.push({
                source_reference: reference,
                source_product_id: String(p.id),
                source_variant_id: v.id ? String(v.id) : null,
                source_sku: sku || null,
                title: p.title,
                variant_title: v.title && v.title !== "Default Title" ? v.title : null,
                price: Number(v.price ?? 0),
            });
        }
    }
    return out;
}

async function listStripe(restrictedKey: string): Promise<SourceProduct[]> {
    const out: SourceProduct[] = [];
    const res = await fetch("https://api.stripe.com/v1/products?limit=100&active=true", {
        headers: { "Authorization": `Bearer ${restrictedKey}` },
    });
    if (!res.ok) throw new Error(`Stripe ${res.status}: ${await res.text().catch(() => "")}`);
    const json = await res.json() as { data?: any[] };
    for (const p of json.data ?? []) {
        // For each product, fetch its default price (or first price).
        let price = 0;
        if (p.default_price) {
            const priceRes = await fetch(`https://api.stripe.com/v1/prices/${p.default_price}`, {
                headers: { "Authorization": `Bearer ${restrictedKey}` },
            });
            if (priceRes.ok) {
                const priceJson = await priceRes.json() as any;
                price = (priceJson.unit_amount ?? 0) / 100;
            }
        }
        out.push({
            source_reference: `RIOKO-PRODUCT-${p.id}`.slice(0, 30),
            source_product_id: p.id,
            source_variant_id: null,
            source_sku: null,
            title: p.name,
            variant_title: null,
            price,
        });
    }
    return out;
}

export async function GET(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const url = new URL(request.url);
    const sourceKind = url.searchParams.get("source_kind");
    if (sourceKind !== "shopify" && sourceKind !== "stripe") {
        return NextResponse.json({ error: "source_kind must be 'shopify' or 'stripe'" }, { status: 400 });
    }

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    try {
        if (sourceKind === "shopify") {
            const row: any = await db.prepare(
                `SELECT shopify_domain, shopify_token, shopify_api_version FROM integrations WHERE user_id = ? LIMIT 1`,
            ).bind(authResult.targetUserId).first();
            if (!row?.shopify_domain || !row?.shopify_token) {
                return NextResponse.json({ error: "Shopify not configured" }, { status: 400 });
            }
            const products = await listShopify(row.shopify_domain, row.shopify_token, row.shopify_api_version ?? "2026-01");
            return NextResponse.json({ products });
        }

        // Stripe path
        const row: any = await db.prepare(
            `SELECT source_config_json FROM connections
             WHERE user_id = ? AND source_kind = 'stripe' LIMIT 1`,
        ).bind(authResult.targetUserId).first();
        if (!row?.source_config_json) {
            return NextResponse.json({ error: "Stripe not configured" }, { status: 400 });
        }
        const cfg = JSON.parse(row.source_config_json);
        const key = cfg.restricted_key ?? cfg.stripe_restricted_key;
        if (!key) return NextResponse.json({ error: "Stripe restricted_key missing" }, { status: 400 });
        const products = await listStripe(String(key));
        return NextResponse.json({ products });
    } catch (e: any) {
        return NextResponse.json({ error: e.message ?? "Source products fetch failed" }, { status: 502 });
    }
}
