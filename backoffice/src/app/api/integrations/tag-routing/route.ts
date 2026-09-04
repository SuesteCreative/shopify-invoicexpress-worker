import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/account";
import { listIxSequences, findSequenceByName, sequenceIdForDocType } from "@/lib/ix-sequences";

export const runtime = "edge";

/**
 * Tag-based invoice routing rules.
 *
 * Stored in `tag_routing_rules` (migration 0017, extended by 0031). When the
 * source payload carries a matching tag (Shopify order tag, or Stripe metadata
 * as `key` / `key:value`), the worker overrides the destination's document
 * type, series/document set and draft-vs-finalize for that one document.
 *
 * `finalize_mode` replaced the old `_draft` document-type suffix. Legacy values
 * are still accepted on input and folded here, so a client that has not been
 * redeployed keeps working.
 */

const SOURCE_KINDS = ["shopify", "stripe", "lodgify", "eupago"];
const DESTINATION_KINDS = ["invoicexpress", "moloni"];
const DOC_TYPES = ["invoice", "invoice_receipt", "simplified_invoice"];
const FINALIZE_MODES = ["finalize", "draft"];

/** IX cannot issue simplified invoices — ix-proxy's contract has no such type. */
const DOC_TYPES_BY_DESTINATION: Record<string, string[]> = {
    invoicexpress: ["invoice", "invoice_receipt"],
    moloni: DOC_TYPES,
};

/** Folds a legacy `<type>_draft` value into { document_type, finalize_mode }. */
function splitLegacyDocType(raw: string | null | undefined): { documentType: string | null; legacyDraft: boolean } {
    const v = String(raw ?? "").trim().toLowerCase();
    if (!v) return { documentType: null, legacyDraft: false };
    if (v.endsWith("_draft")) return { documentType: v.slice(0, -"_draft".length), legacyDraft: true };
    return { documentType: v, legacyDraft: false };
}

async function resolveTargetUser(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return { error: "Unauthorized", status: 401 as const };

    let targetUserId = await resolveAccountUser(request, userId);
    return { userId, targetUserId };
}

type Row = {
    id: string;
    source_kind: string;
    destination_kind: string;
    tag_name: string;
    document_type: string | null;
    series_name: string | null;
    finalize_mode: string | null;
    created_at: string;
    updated_at: string;
};

export async function GET(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const url = new URL(request.url);
    const sourceKind = url.searchParams.get("source_kind") ?? "shopify";
    const destinationKind = url.searchParams.get("destination_kind") ?? "invoicexpress";

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    const rows = await db.prepare(
        `SELECT id, source_kind, destination_kind, tag_name, document_type, series_name, finalize_mode, created_at, updated_at
         FROM tag_routing_rules
         WHERE user_id = ? AND source_kind = ? AND destination_kind = ?
         ORDER BY created_at ASC`,
    ).bind(authResult.targetUserId, sourceKind, destinationKind).all();

    return NextResponse.json({ rules: (rows.results ?? []) as Row[] });
}

type PostBody = {
    source_kind?: string;
    destination_kind?: string;
    tag_name?: string;
    document_type?: string | null;
    series_name?: string | null;
    finalize_mode?: string | null;
};

export async function POST(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const body = await request.json() as PostBody;
    const sourceKind = (body.source_kind ?? "shopify").trim();
    const destinationKind = (body.destination_kind ?? "invoicexpress").trim();
    const tagName = (body.tag_name ?? "").trim();

    if (!tagName) return NextResponse.json({ error: "tag_name required" }, { status: 400 });

    // These were validated client-side only, so a rule could be written against
    // a source/destination the worker never reads — invisible dead config.
    if (!SOURCE_KINDS.includes(sourceKind)) {
        return NextResponse.json({ error: `Unknown source_kind: ${sourceKind}` }, { status: 400 });
    }
    if (!DESTINATION_KINDS.includes(destinationKind)) {
        return NextResponse.json({ error: `Unknown destination_kind: ${destinationKind}` }, { status: 400 });
    }

    const { documentType: rawType, legacyDraft } = splitLegacyDocType(body.document_type);
    const allowedTypes = DOC_TYPES_BY_DESTINATION[destinationKind] ?? DOC_TYPES;
    if (rawType && !allowedTypes.includes(rawType)) {
        return NextResponse.json(
            { error: `document_type "${rawType}" is not supported by ${destinationKind}` },
            { status: 400 },
        );
    }
    const documentType = rawType;

    const requestedMode = String(body.finalize_mode ?? "").trim().toLowerCase();
    const finalizeMode = FINALIZE_MODES.includes(requestedMode)
        ? requestedMode
        : legacyDraft ? "draft" : null;

    const seriesName = (body.series_name ?? "").trim() || null;

    // finalize_mode alone is a legitimate rule: "same document type and series,
    // just don't close it" is exactly the sales-channel case this exists for.
    if (!documentType && !seriesName && !finalizeMode) {
        return NextResponse.json(
            { error: "At least one of document_type, series_name or finalize_mode must be set" },
            { status: 400 },
        );
    }

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    // A series name InvoiceXpress does not know is caught here, at the one
    // moment someone is looking at it, rather than at 3am on a sale. Until now
    // an unknown name silently fell back to the account's default series — with
    // one series per destination country, that files a sale under the wrong
    // country and nothing says so.
    //
    // Only a definitive negative blocks: an account with no stored credentials,
    // or an InvoiceXpress that did not answer, returns null and the rule is
    // saved. Refusing a legitimate rule because a lookup was flaky would be the
    // worse failure.
    if (seriesName && destinationKind === "invoicexpress") {
        const sequences = await listIxSequences(db, authResult.targetUserId);
        if (sequences !== null) {
            const match = findSequenceByName(sequences, seriesName);
            if (!match) {
                const known = sequences.map(s => s.serie).filter(Boolean).join(", ");
                return NextResponse.json({
                    error: `A série "${seriesName}" não existe na conta InvoiceXpress.`
                        + (known ? ` Séries disponíveis: ${known}.` : " A conta não tem séries criadas."),
                }, { status: 400 });
            }
            // The series exists, but not for the document type this rule issues.
            // IX refuses that combination outright ("A série não corresponde ao
            // tipo de documento"), so the sale would never be invoiced.
            const forType = documentType ?? "invoice";
            if (sequenceIdForDocType(match, forType) === null) {
                return NextResponse.json({
                    error: `A série "${seriesName}" não tem numeração para ${forType} na conta InvoiceXpress.`,
                }, { status: 400 });
            }
        }
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.prepare(
        `INSERT INTO tag_routing_rules
          (id, user_id, source_kind, destination_kind, tag_name, document_type, series_name, finalize_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, source_kind, destination_kind, tag_name) DO UPDATE SET
           document_type = excluded.document_type,
           series_name = excluded.series_name,
           finalize_mode = excluded.finalize_mode,
           updated_at = excluded.updated_at`,
    ).bind(
        id, authResult.targetUserId, sourceKind, destinationKind,
        tagName, documentType, seriesName, finalizeMode, now, now,
    ).run();

    return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const url = new URL(request.url);
    const id = url.searchParams.get("id");

    if (!id) return NextResponse.json({ error: "Pass ?id=" }, { status: 400 });

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    await db.prepare(
        `DELETE FROM tag_routing_rules WHERE id = ? AND user_id = ?`,
    ).bind(id, authResult.targetUserId).run();

    return NextResponse.json({ ok: true });
}
