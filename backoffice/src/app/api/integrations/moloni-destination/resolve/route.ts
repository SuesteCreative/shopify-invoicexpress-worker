import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getImpersonationId } from "@/lib/admin";

export const runtime = "edge";

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

async function moloniFetch(url: string, init: RequestInit): Promise<Response> {
    return fetch(url, {
        ...init,
        // AbortSignal.timeout is handled at the native fetch layer — survives
        // even if the JS event loop is blocked. 10s is generous given Moloni
        // responds in <100ms from a normal network; if this fires it means CF
        // edge IPs are filtered by Moloni's firewall.
        signal: AbortSignal.timeout(10_000),
    });
}

export async function POST(request: NextRequest) {
    try {
        const authResult = await resolveTargetUser(request);
        if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

        const body = await request.json() as {
            source_kind?: string;
            company_name?: string;
            document_set_name?: string;
        };

        const companyName = body.company_name?.trim();
        const documentSetName = body.document_set_name?.trim();
        if (!companyName || !documentSetName) {
            return NextResponse.json({ error: "company_name and document_set_name are required" }, { status: 400 });
        }

        const { env } = getRequestContext();
        const db = (env as any).DB;
        if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

        const rawSource = body.source_kind ?? "stripe";
        const sourceKind = rawSource === "shopify" ? "shopify" : "stripe";

        const row: any = await db.prepare(
            `SELECT destination_config_json FROM connections
             WHERE user_id = ? AND source_kind = ? AND destination_kind = 'moloni' LIMIT 1`
        ).bind(authResult.targetUserId, sourceKind).first();

        if (!row?.destination_config_json) {
            return NextResponse.json({ error: "Moloni credentials not found — save Step 2 first." }, { status: 404 });
        }

        let cfg: any;
        try { cfg = JSON.parse(row.destination_config_json); } catch {
            return NextResponse.json({ error: "Stored Moloni config is corrupted — re-save Step 2." }, { status: 500 });
        }

        if (!cfg.moloni_client_id || !cfg.moloni_client_secret || !cfg.moloni_username || !cfg.moloni_password) {
            return NextResponse.json({ error: "Moloni credentials incomplete — re-save Step 2 with all fields." }, { status: 400 });
        }

        const baseUrl = cfg.moloni_environment === "sandbox"
            ? "https://apidemo.moloni.pt/v1"
            : "https://api.moloni.pt/v1";

        const tokenUrl = new URL(`${baseUrl}/grant/`);
        tokenUrl.searchParams.set("grant_type", "password");
        tokenUrl.searchParams.set("client_id", String(cfg.moloni_client_id));
        tokenUrl.searchParams.set("client_secret", String(cfg.moloni_client_secret));
        tokenUrl.searchParams.set("username", String(cfg.moloni_username));
        tokenUrl.searchParams.set("password", String(cfg.moloni_password));

        // Step 1: auth
        let tokenRes: Response;
        try {
            tokenRes = await moloniFetch(tokenUrl.toString(), {
                method: "POST",
                headers: { "Content-Type": "application/json", "Accept": "application/json" },
            });
        } catch (e: any) {
            const msg = e?.name === "AbortError" || e?.name === "TimeoutError"
                ? "Moloni API did not respond in 10s — Cloudflare edge IPs may be blocked by Moloni. Contact Moloni support or use a reverse proxy."
                : `Moloni auth unreachable: ${e?.message ?? "network error"}`;
            return NextResponse.json({ error: msg }, { status: 502 });
        }

        if (!tokenRes.ok) {
            const errBody: any = await tokenRes.json().catch(() => ({}));
            return NextResponse.json({
                error: `Moloni auth failed (${tokenRes.status}): ${errBody?.error_description ?? errBody?.message ?? "check credentials"}`,
            }, { status: 502 });
        }

        const tokenData: any = await tokenRes.json().catch(() => ({}));
        const token = tokenData?.access_token;
        if (!token) {
            return NextResponse.json({ error: "Moloni auth returned no token" }, { status: 502 });
        }

        // Step 2: list companies
        let companiesRes: Response;
        try {
            companiesRes = await moloniFetch(
                `${baseUrl}/companies/getAll/?access_token=${encodeURIComponent(token)}&json=true`,
                { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" }, body: "" },
            );
        } catch (e: any) {
            return NextResponse.json({ error: `Moloni companies request timed out: ${e?.message ?? "network error"}` }, { status: 502 });
        }

        const companiesData: any = await companiesRes.json().catch(() => []);
        const companies: Array<{ id: string; name: string }> = Array.isArray(companiesData)
            ? companiesData.map((c: any) => ({ id: String(c.id), name: String(c.name ?? c.company_name ?? c.id) }))
            : [];

        const company = companies.find(c => c.name.toLowerCase() === companyName.toLowerCase());
        if (!company) {
            const names = companies.map(c => `"${c.name}"`).join(", ");
            return NextResponse.json({
                error: `Company "${companyName}" not found. Available: ${names || "(none)"}`,
            }, { status: 404 });
        }

        // Step 3: list document sets for that company
        let dsRes: Response;
        try {
            dsRes = await moloniFetch(
                `${baseUrl}/documentSets/getAll/?access_token=${encodeURIComponent(token)}&json=true`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
                    body: new URLSearchParams({ company_id: company.id }).toString(),
                },
            );
        } catch (e: any) {
            return NextResponse.json({ error: `Moloni document-sets request timed out: ${e?.message ?? "network error"}` }, { status: 502 });
        }

        const dsData: any = await dsRes.json().catch(() => []);
        const documentSets: Array<{ id: string; name: string }> = Array.isArray(dsData)
            ? dsData.map((d: any) => ({ id: String(d.id), name: String(d.name ?? d.document_set_name ?? d.id) }))
            : [];

        const documentSet = documentSets.find(d => d.name.toLowerCase() === documentSetName.toLowerCase());
        if (!documentSet) {
            const names = documentSets.map(d => `"${d.name}"`).join(", ");
            return NextResponse.json({
                error: `Document set "${documentSetName}" not found. Available: ${names || "(none)"}`,
            }, { status: 404 });
        }

        return NextResponse.json({
            company_id: company.id,
            company_name: company.name,
            document_set_id: documentSet.id,
            document_set_name: documentSet.name,
        });
    } catch (e: any) {
        return NextResponse.json({ error: `Unexpected error: ${e?.message ?? "unknown"}` }, { status: 500 });
    }
}
