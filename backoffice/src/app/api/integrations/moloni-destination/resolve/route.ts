import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/account";
import { sourceKindOrNull, unknownSourceKindError } from "@/lib/connection-kinds";
import { listMoloniCompanies, listMoloniDocumentSets, moloniConnectionToken } from "@/lib/moloni-token";

export const runtime = "edge";

async function resolveTargetUser(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return { error: "Unauthorized", status: 401 as const };
    let targetUserId = await resolveAccountUser(request, userId);
    return { userId, targetUserId };
}

/**
 * Resolves a company name and a document-set name to their Moloni ids, for one
 * connection.
 *
 * Authenticates the way the connection does — see `moloniConnectionToken`. It
 * used to demand a username and a password and send them through a worker proxy
 * that only knows that grant, so for every OAuth connection it answered
 * "credentials incomplete".
 */
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

        const sourceKind = sourceKindOrNull(body.source_kind, "stripe");
        if (!sourceKind) return NextResponse.json({ error: unknownSourceKindError(body.source_kind) }, { status: 400 });

        const conn = await moloniConnectionToken(db, authResult.targetUserId, sourceKind);
        if (!conn.ok) return NextResponse.json({ error: conn.error }, { status: conn.status });

        const companies = await listMoloniCompanies(conn.cfg, conn.token);
        const company = companies.find((c) => c.name.toLowerCase() === companyName.toLowerCase());
        if (!company) {
            const names = companies.map((c) => `"${c.name}"`).join(", ");
            return NextResponse.json(
                { error: `Company "${companyName}" not found. Available: ${names || "(none)"}` },
                { status: 404 },
            );
        }

        const documentSets = await listMoloniDocumentSets(conn.cfg, conn.token, company.id);
        const documentSet = documentSets.find((d) => d.name.toLowerCase() === documentSetName.toLowerCase());
        if (!documentSet) {
            const names = documentSets.map((d) => `"${d.name}"`).join(", ");
            return NextResponse.json(
                { error: `Document set "${documentSetName}" not found. Available: ${names || "(none)"}` },
                { status: 404 },
            );
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
