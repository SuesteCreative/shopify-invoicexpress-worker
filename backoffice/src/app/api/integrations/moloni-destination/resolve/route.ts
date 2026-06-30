import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getImpersonationId } from "@/lib/admin";
import { RIOKO_CONFIG } from "@/lib/config";

export const runtime = "edge";

const WORKER_BASE = RIOKO_CONFIG.workerUrl.replace(/\/$/, "");

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

export async function POST(request: NextRequest) {
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

    const cfg = JSON.parse(row.destination_config_json);
    const creds = {
        client_id: cfg.moloni_client_id,
        client_secret: cfg.moloni_client_secret,
        username: cfg.moloni_username,
        password: cfg.moloni_password,
        environment: cfg.moloni_environment ?? "production",
    };

    // Step 1: resolve company name → ID
    const companiesRes = await fetch(`${WORKER_BASE}/moloni-proxy/companies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(creds),
    });
    const companiesData: any = await companiesRes.json().catch(() => ({}));
    if (!companiesRes.ok) {
        return NextResponse.json({ error: companiesData?.error ?? `Could not fetch companies (${companiesRes.status})` }, { status: 502 });
    }

    const companies: Array<{ id: string; name: string }> = companiesData.companies ?? [];
    const company = companies.find(c => c.name.toLowerCase() === companyName.toLowerCase());
    if (!company) {
        const names = companies.map(c => `"${c.name}"`).join(", ");
        return NextResponse.json({
            error: `Company "${companyName}" not found. Available: ${names || "(none)"}`,
        }, { status: 404 });
    }

    // Step 2: resolve document set name → ID
    const dsRes = await fetch(`${WORKER_BASE}/moloni-proxy/document-sets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...creds, company_id: company.id }),
    });
    const dsData: any = await dsRes.json().catch(() => ({}));
    if (!dsRes.ok) {
        return NextResponse.json({ error: dsData?.error ?? `Could not fetch document sets (${dsRes.status})` }, { status: 502 });
    }

    const documentSets: Array<{ id: string; name: string }> = dsData.documentSets ?? [];
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
}
