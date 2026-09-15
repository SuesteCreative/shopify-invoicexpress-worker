import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/account";
import { sourceKindOrNull, unknownSourceKindError } from "@/lib/connection-kinds";
import { listMoloniCompanies, listMoloniDocumentSets, moloniConnectionToken } from "@/lib/moloni-token";

export const runtime = "edge";

/**
 * The document sets of one Moloni connection, as [{ id, serie }] — the same shape
 * as sequences-user, so the tag-routing page can use one Sequence type whatever
 * the destination.
 *
 * Query params:
 *   source_kind  — which Moloni connection to read (default: "lodgify")
 *
 * Authenticates the way the connection does. It used to require a username and
 * a password and answer an empty list without them, so for every OAuth
 * connection — every Stripe Connect merchant on 15/09/2026 — the tag-routing
 * page offered no séries at all, while the connection itself was issuing
 * documents normally.
 *
 * Still answers `[]` rather than an error when it cannot tell: the page renders
 * an empty picker, which is what it has always done.
 */
export async function GET(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    let targetUserId = await resolveAccountUser(request, userId);

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    // The whitelist here had no `stripe_connect`, and the fallback was
    // "lodgify". The tag-routing page asks with `source_kind=stripe_connect`, so
    // a Stripe Connect merchant building a tag rule was shown the document sets
    // of their LODGIFY connection — read with that connection's Moloni
    // credentials — and could save a rule naming a series that belongs to
    // another integration.
    const rawSrc = new URL(request.url).searchParams.get("source_kind");
    const sourceKind = sourceKindOrNull(rawSrc, "lodgify");
    if (!sourceKind) return NextResponse.json({ error: unknownSourceKindError(rawSrc) }, { status: 400 });

    const conn = await moloniConnectionToken(db, targetUserId, sourceKind);
    if (!conn.ok) return NextResponse.json([]);

    try {
        // The stored id when there is one, otherwise the company the merchant named.
        let companyId = Number(conn.cfg.moloni_company_id ?? 0);
        if (!companyId && conn.cfg.moloni_company_name) {
            const wanted = String(conn.cfg.moloni_company_name).toLowerCase();
            companyId = (await listMoloniCompanies(conn.cfg, conn.token))
                .find((c) => c.name.toLowerCase() === wanted)?.id ?? 0;
        }
        if (!companyId) return NextResponse.json([]);

        const sets = await listMoloniDocumentSets(conn.cfg, conn.token, companyId);
        return NextResponse.json(sets.map((d) => ({ id: d.id, serie: d.name })));
    } catch {
        return NextResponse.json([]);
    }
}
