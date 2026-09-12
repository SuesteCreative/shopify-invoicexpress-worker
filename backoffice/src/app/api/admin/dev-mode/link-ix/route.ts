import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { getDB } from "@/lib/stripe";
import { listDocumentIndex } from "@/lib/invoicexpress-kapta";
import { findInIndex, type KaptaDocSummary } from "@/lib/kapta-doc-number";

export const runtime = "edge";

/**
 * The Kapta service invoice a merchant sees under Faturação, and the admin's way
 * to correct it.
 *
 * A link can be wrong without anything having failed: the nightly matcher pairs a
 * payment to a document by heuristic (name, NIF, amount, date proximity), so a
 * document later cancelled and re-issued stays pinned to the payment and the
 * merchant reads a cancelled invoice as their own. Only a human knows which
 * document replaced it.
 *
 * Three things this deliberately does NOT do:
 *
 *  - It never clears a link. `cron/ix-match` sweeps `ix_invoice_id IS NULL` for 30
 *    days and re-runs the same heuristic, so an emptied event would be re-linked
 *    to the very document the admin just rejected. Replacement is one UPDATE.
 *  - It takes the document NUMBER, not an id or a pasted URL. The number is what
 *    is printed on the document; the id appears nowhere a human can read, and a
 *    hand-pasted back-office URL sits behind the Kapta login — the merchant would
 *    click it and get a sign-in page.
 *  - It refuses a cancelled document, and one already linked to another payment,
 *    unless the caller says `force`. Both are the mistakes this tool exists to
 *    undo; allowing them silently would only move the problem.
 */

const LISTED_TYPES = ["invoice.paid", "invoice.payment_failed", "charge.refunded"] as const;

/** A refund is credited by a credit note; everything else by an invoice. */
function docTypeFor(eventType: string): "invoice" | "credit_note" {
    return eventType === "charge.refunded" ? "credit_note" : "invoice";
}

/** Ids written before `String(doc.id)` landed read back as "267793087.0" — D1 binds
 * a JS number into a TEXT column through REAL. Both spellings mean one document. */
function idVariants(id: string): string[] {
    const bare = id.replace(/\.0$/, "");
    return bare === id ? [id, `${id}.0`] : [bare, id];
}

async function auditLink(
    db: any,
    entry: { userId: string; actor: string | null; eventId: string; oldValue: string | null; newValue: string },
) {
    try {
        await db.prepare(
            `INSERT INTO config_audit (id, user_id, actor, scope, field, old_value, new_value)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
            crypto.randomUUID(), entry.userId, entry.actor,
            `billing_event:${entry.eventId}`, "ix_invoice_id",
            entry.oldValue, entry.newValue,
        ).run();
    } catch (e) {
        // Losing the audit line must never be why a correction fails.
        console.warn("[link-ix] audit write failed:", e);
    }
}

/**
 * A user's billing events with whatever Kapta document each one points at.
 *
 * Every event, not only the unlinked ones: an event linked to the WRONG document
 * is the case this panel exists for, and filtering on `ix_invoice_id IS NULL` hid
 * exactly those.
 */
export async function GET(req: NextRequest) {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const targetUserId = req.nextUrl.searchParams.get("targetUserId");
    if (!targetUserId) return NextResponse.json({ error: "targetUserId required" }, { status: 400 });

    const db = getDB();
    const rows: any = await db.prepare(`
        SELECT id, type, stripe_object_id, payment_intent_id, amount_cents, currency,
               status, ix_invoice_id, ix_invoice_permalink, ix_match_method, ix_match_score, created_at
        FROM billing_events
        WHERE user_id = ? AND type IN (${LISTED_TYPES.map(() => "?").join(",")})
        ORDER BY created_at DESC
        LIMIT 100
    `).bind(targetUserId, ...LISTED_TYPES).all();

    const events: any[] = rows.results || [];

    // Which of these links is shared with another payment. One Kapta document
    // billed twice is the matcher's other failure mode, and it is invisible from
    // the merchant's side, so surface it next to the link it affects.
    const linked = events.map(e => e.ix_invoice_id).filter(Boolean).map(String);
    const shared = new Set<string>();
    if (linked.length > 0) {
        const variants = [...new Set(linked.flatMap(idVariants))];
        const dup: any = await db.prepare(`
            SELECT ix_invoice_id, COUNT(*) AS n FROM billing_events
            WHERE ix_invoice_id IN (${variants.map(() => "?").join(",")})
            GROUP BY replace(ix_invoice_id, '.0', '')
            HAVING n > 1
        `).bind(...variants).all();
        for (const r of dup.results || []) shared.add(String(r.ix_invoice_id).replace(/\.0$/, ""));
    }

    // The number and the state, which is what identifies a document to a human.
    // Best-effort: InvoiceXpress being slow must not empty the panel.
    let invoices = new Map<string, KaptaDocSummary>();
    let creditNotes = new Map<string, KaptaDocSummary>();
    let ixError: string | null = null;
    try {
        const linkedTypes = new Set(events.filter(e => e.ix_invoice_id).map(e => docTypeFor(String(e.type))));
        if (linkedTypes.has("invoice")) invoices = await listDocumentIndex("invoice");
        if (linkedTypes.has("credit_note")) creditNotes = await listDocumentIndex("credit_note");
    } catch (e: any) {
        ixError = String(e?.message || e);
    }

    return NextResponse.json({
        ix_error: ixError,
        events: events.map(e => {
            const id = e.ix_invoice_id ? String(e.ix_invoice_id) : null;
            const from = docTypeFor(String(e.type)) === "credit_note" ? creditNotes : invoices;
            const doc = id ? (from.get(id) ?? from.get(id.replace(/\.0$/, "")) ?? null) : null;
            return {
                ...e,
                ix_doc_number: doc?.number ?? null,
                ix_doc_state: doc?.state ?? null,
                ix_shared_with_another_payment: id ? shared.has(id.replace(/\.0$/, "")) : false,
            };
        }),
    });
}

/** Attach a Kapta document to a billing event, replacing whatever was there. */
export async function POST(req: NextRequest) {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json() as {
        targetUserId: string;
        billing_event_id: string;
        /** "KAPTA2026/673" — the number printed on the document. */
        ix_number?: string;
        /** Escape hatch for a document older than the list this reads. */
        ix_permalink?: string;
        ix_invoice_id?: string;
        /** Accept a cancelled document, or one already billed to another payment. */
        force?: boolean;
    };

    if (!body.targetUserId || !body.billing_event_id) {
        return NextResponse.json({ error: "targetUserId and billing_event_id are required" }, { status: 400 });
    }
    if (!body.ix_number?.trim() && !body.ix_permalink?.trim()) {
        return NextResponse.json({ error: "ix_number (or ix_permalink) is required" }, { status: 400 });
    }

    const db = getDB();
    const event: any = await db.prepare(`
        SELECT id, type, ix_invoice_id, ix_match_method FROM billing_events WHERE id = ? AND user_id = ?
    `).bind(body.billing_event_id, body.targetUserId).first();
    if (!event) {
        return NextResponse.json({ error: "No matching billing event for that id / user" }, { status: 404 });
    }

    let docId: string;
    let permalink: string | null;
    let doc: KaptaDocSummary | null = null;

    if (body.ix_number?.trim()) {
        const docType = docTypeFor(String(event.type));
        const index = await listDocumentIndex(docType);
        if (index.size === 0) {
            return NextResponse.json({ error: "Could not read the Kapta account from InvoiceXpress" }, { status: 502 });
        }
        doc = findInIndex(index, body.ix_number);
        if (!doc) {
            return NextResponse.json({
                error: `No ${docType === "credit_note" ? "credit note" : "invoice"} numbered "${body.ix_number.trim()}" in the Kapta account`,
            }, { status: 404 });
        }
        if (doc.state === "canceled" && !body.force) {
            return NextResponse.json({
                error: `${doc.number} is cancelled in InvoiceXpress — the merchant would see a cancelled invoice again`,
                needs_force: true, doc,
            }, { status: 409 });
        }
        docId = doc.id;
        permalink = doc.permalink;
    } else {
        // A document past the pages this lists (InvoiceXpress has no lookup by
        // number) can still be attached by hand. Narrow on purpose: a pasted link
        // is checked against nothing.
        permalink = body.ix_permalink!.trim();
        if (!/^https?:\/\//i.test(permalink)) {
            return NextResponse.json({ error: "ix_permalink must be a full URL (https://…)" }, { status: 400 });
        }
        docId = body.ix_invoice_id?.trim() || permalink.replace(/\/+$/, "").split("/").pop() || "manual";
    }

    // Already billed to another payment? One document on two payments is the other
    // way this goes wrong, and it is the merchant who finds out, not us.
    if (!body.force) {
        const variants = idVariants(docId);
        const other: any = await db.prepare(`
            SELECT id, user_id, created_at FROM billing_events
            WHERE ix_invoice_id IN (${variants.map(() => "?").join(",")}) AND id <> ?
            LIMIT 1
        `).bind(...variants, body.billing_event_id).first();
        if (other) {
            return NextResponse.json({
                error: `${doc?.number || docId} is already linked to billing event ${other.id}`,
                needs_force: true, conflict: other,
            }, { status: 409 });
        }
    }

    const res: any = await db.prepare(`
        UPDATE billing_events
        SET ix_invoice_id = ?, ix_invoice_permalink = ?, ix_match_method = 'manual', ix_match_score = 100
        WHERE id = ? AND user_id = ?
    `).bind(docId, permalink, body.billing_event_id, body.targetUserId).run();

    const changes = res?.meta?.changes ?? res?.changes ?? 0;
    if (!changes) {
        return NextResponse.json({ error: "No matching billing event for that id / user" }, { status: 404 });
    }

    await auditLink(db, {
        userId: body.targetUserId,
        actor: userId,
        eventId: body.billing_event_id,
        oldValue: event.ix_invoice_id ? `${event.ix_invoice_id} (${event.ix_match_method || "?"})` : null,
        newValue: `${docId}${doc?.number ? ` (${doc.number})` : ""} (manual)`,
    });

    return NextResponse.json({
        success: true,
        ix_invoice_id: docId,
        ix_invoice_permalink: permalink,
        ix_doc_number: doc?.number ?? null,
        ix_doc_state: doc?.state ?? null,
        replaced: event.ix_invoice_id ?? null,
    });
}
