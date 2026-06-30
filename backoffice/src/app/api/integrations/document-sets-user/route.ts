import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getImpersonationId } from "@/lib/admin";

export const runtime = "edge";

/**
 * Reads the authenticated user's stored Moloni credentials from D1, OAuth-authenticates,
 * resolves the company ID (numeric or via name lookup), and returns the available
 * document sets as [{ id, serie }] — same shape as sequences-user so the tag-routing
 * page can reuse the same Sequence type regardless of destination.
 *
 * Query params:
 *   source_kind  — which Moloni connection to read (default: "lodgify")
 */
export async function GET(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    let targetUserId = userId;
    if (await isAdmin(userId)) {
        const impersonationId = await getImpersonationId(request);
        if (impersonationId) targetUserId = impersonationId;
    }

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    const rawSrc = new URL(request.url).searchParams.get("source_kind") ?? "lodgify";
    const sourceKind = ["shopify", "stripe", "lodgify"].includes(rawSrc) ? rawSrc : "lodgify";

    const row: any = await db
        .prepare(
            `SELECT destination_config_json FROM connections
             WHERE user_id = ? AND source_kind = ? AND destination_kind = 'moloni' LIMIT 1`
        )
        .bind(targetUserId, sourceKind)
        .first();

    if (!row?.destination_config_json) return NextResponse.json([]);

    const cfg = JSON.parse(row.destination_config_json) as Record<string, string | number | null>;

    const clientId = String(cfg.moloni_client_id ?? "").trim();
    const clientSecret = String(cfg.moloni_client_secret ?? "").trim();
    const username = String(cfg.moloni_username ?? "").trim();
    const password = String(cfg.moloni_password ?? "").trim();

    if (!clientId || !clientSecret || !username || !password) return NextResponse.json([]);

    const baseUrl = (cfg.moloni_environment ?? "production") === "sandbox"
        ? "https://apidemo.moloni.pt/v1"
        : "https://api.moloni.pt/v1";

    // OAuth password grant
    const tokenUrl = new URL(`${baseUrl}/grant/`);
    tokenUrl.searchParams.set("grant_type", "password");
    tokenUrl.searchParams.set("client_id", clientId);
    tokenUrl.searchParams.set("client_secret", clientSecret);
    tokenUrl.searchParams.set("username", username);
    tokenUrl.searchParams.set("password", password);

    let token: string;
    try {
        const tokenRes = await fetch(tokenUrl.toString(), {
            method: "POST",
            headers: { "Accept": "application/json" },
        });
        if (!tokenRes.ok) return NextResponse.json([]);
        const tokenData: any = await tokenRes.json();
        token = tokenData?.access_token;
        if (!token) return NextResponse.json([]);
    } catch {
        return NextResponse.json([]);
    }

    // Resolve company ID — use stored numeric id or resolve from name
    let companyId = Number(cfg.moloni_company_id ?? 0);
    if (!companyId && cfg.moloni_company_name) {
        try {
            const companiesRes = await fetch(
                `${baseUrl}/companies/getAll/?access_token=${encodeURIComponent(token)}&json=true`,
                { method: "POST", headers: { "Accept": "application/json" } },
            );
            if (companiesRes.ok) {
                const companies = await companiesRes.json().catch(() => []) as any[];
                if (Array.isArray(companies)) {
                    const match = companies.find((c: any) =>
                        String(c.name ?? c.company_name ?? "").toLowerCase() ===
                        String(cfg.moloni_company_name).toLowerCase()
                    );
                    if (match) companyId = Number(match.company_id ?? match.id ?? 0);
                }
            }
        } catch { /* fall through — companyId stays 0 */ }
    }
    if (!companyId) return NextResponse.json([]);

    // Fetch document sets
    try {
        const dsRes = await fetch(
            `${baseUrl}/documentSets/getAll/?access_token=${encodeURIComponent(token)}&json=true`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json", "Accept": "application/json" },
                body: JSON.stringify({ company_id: companyId }),
            },
        );
        if (!dsRes.ok) return NextResponse.json([]);
        const dsList = await dsRes.json().catch(() => []) as any[];
        if (!Array.isArray(dsList)) return NextResponse.json([]);
        // Normalize to the same [{ id, serie }] shape as sequences-user
        return NextResponse.json(
            dsList
                .map((d: any) => ({
                    id: Number(d.document_set_id ?? d.id ?? 0),
                    serie: String(d.name ?? d.document_set_name ?? ""),
                }))
                .filter((d) => d.id > 0 && d.serie)
        );
    } catch {
        return NextResponse.json([]);
    }
}
