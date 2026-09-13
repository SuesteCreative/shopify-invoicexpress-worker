import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";

import { resolveAccountUser, isReadOnlyMember } from "@/lib/account";
import { isAdmin, getImpersonationId } from "@/lib/admin";
import { auditConfigChange } from "@/lib/config-audit";
import { identityRequestStates, unreadIdentityOutcomes } from "@/lib/client-record-sql";
import { accountLabel } from "@/lib/labels";
import { callWorkerJson } from "@/lib/worker";
import { SUPPORT_EMAIL } from "@/lib/config";

export const runtime = "edge";

/**
 * "This NIF is wrong" — the one thing the Conta page cannot just save.
 *
 * The NIF and the legal company name print on invoices that are already issued
 * and are what the payment matcher pairs on, so changing one is a decision an
 * operator makes, not a field a merchant edits. This is how they ask.
 *
 * It lands in `config_audit`, which is where the customer record's Registos tab
 * already reads from, and it is sent on by the worker — which is where the Resend
 * credentials live; the backoffice has no mailer of its own and should not grow
 * one for this.
 *
 * NOT an `incidents` row, which would have brought a status and an ops UI for
 * free: `autoResolveStaleIncidents` closes any open incident older than 24h whose
 * kind is not in INVOICE_FAILURE_KINDS (src/services/incidents.ts). The request
 * would quietly disappear the next day, which is worse than having no queue at
 * all. The state is DERIVED instead: a request is outstanding while the value
 * asked for still differs from the one stored.
 */

const EDITABLE_BY_REQUEST = new Set(["nif", "company_name"]);
const MAX_NOTE = 500;

/** The trail this account's fiscal identity has, and where they left off. */
const TRAIL_SQL = `
    SELECT scope, field, old_value, new_value, actor, created_at
      FROM config_audit
     WHERE user_id = ?
       AND scope IN ('profile_change_request', 'profile', 'profile_change_rejected')
     ORDER BY created_at DESC, rowid DESC LIMIT 40`;

/**
 * What became of what they asked, and what they have not been shown yet.
 *
 * The client's half of the loop. Their requests used to travel one way: the
 * operator granted or refused one on the customer record and the merchant found
 * out by noticing the value had changed, or never.
 *
 * `identity_notice_seen_at` (migration 0059) is the whole of the read state — a
 * decision newer than it has not been seen. Before that migration is applied
 * this answers with an empty list rather than failing: a notice is not worth a
 * broken dashboard.
 */
export async function GET(request: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const accountId = await resolveAccountUser(request, userId);

        const { env } = getRequestContext();
        const db = (env as any).DB;
        if (!db) return NextResponse.json({ states: [], unread: [] });

        const account: any = await db
            .prepare("SELECT nif, company_name, identity_notice_seen_at FROM users WHERE id = ?")
            .bind(accountId).first()
            .catch(() => null);
        if (!account) return NextResponse.json({ states: [], unread: [] });

        const rows = await db.prepare(TRAIL_SQL).bind(accountId).all().catch(() => ({ results: [] }));
        const states = identityRequestStates((rows.results ?? []) as any[], account);

        // A read-only member cannot write the dismissal, so the notice would
        // never go away for them. The page is told, and hides it for the session
        // instead of pretending the button works.
        const readOnly = await isReadOnlyMember(userId);

        return NextResponse.json({
            states,
            unread: unreadIdentityOutcomes(states, account.identity_notice_seen_at ?? null),
            can_dismiss: !readOnly,
        });
    } catch (error: any) {
        if (error?.name === "ReadOnlyMemberError") return NextResponse.json({ states: [], unread: [] });
        console.error("[user/identity-request] GET failed:", error?.message ?? error);
        return NextResponse.json({ states: [], unread: [] });
    }
}

export async function POST(request: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const body = await request.json() as {
            field?: string; requested?: string; note?: string; dismiss?: boolean;
        };

        // ── Dismissing the notice ──────────────────────────────────────────────
        //
        // Stamped on the ACCOUNT, so a decision older than this moment stops
        // being announced — on this browser and on every other one, which is the
        // reason it is a column and not local storage.
        //
        // Refused under impersonation on purpose: an operator clicking through a
        // client's dashboard must not be able to mark, on that client's behalf,
        // that they have seen an answer they have never seen.
        if (body.dismiss === true) {
            const { env: dismissEnv } = getRequestContext();
            const dismissDb = (dismissEnv as any).DB;
            if (!dismissDb) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

            const impersonating = !!(await getImpersonationId(request)) && (await isAdmin(userId));
            if (impersonating) return NextResponse.json({ success: false, reason: "impersonating" });

            const account = await resolveAccountUser(request, userId);
            const done = await dismissDb
                .prepare("UPDATE users SET identity_notice_seen_at = CURRENT_TIMESTAMP WHERE id = ?")
                .bind(account).run()
                .then(() => true)
                // Pre-0059: the column is not there yet and the notice simply
                // keeps showing. Not worth an error the client would see.
                .catch(() => false);

            return NextResponse.json({ success: done });
        }

        const field = String(body.field ?? "");
        if (!EDITABLE_BY_REQUEST.has(field)) {
            return NextResponse.json({ error: "field_not_requestable" }, { status: 400 });
        }

        const requested = String(body.requested ?? "").trim();
        if (!requested) return NextResponse.json({ error: "requested_required" }, { status: 400 });
        if (requested.length > 120) return NextResponse.json({ error: "requested_too_long" }, { status: 400 });

        const note = String(body.note ?? "").trim().slice(0, MAX_NOTE);

        // Throws for a read-only member, which is the same rule every other write
        // on this account follows.
        const accountId = await resolveAccountUser(request, userId);

        const { env } = getRequestContext();
        const db = (env as any).DB;
        if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

        const account: any = await db
            .prepare("SELECT id, email, name, company_name, admin_label, nif, client_code FROM users WHERE id = ?")
            .bind(accountId).first()
            .catch(() => db.prepare("SELECT id, email, name, company_name, admin_label, nif FROM users WHERE id = ?")
                .bind(accountId).first());
        if (!account) return NextResponse.json({ error: "user_row_missing" }, { status: 409 });

        const current = String(account[field] ?? "");
        if (current === requested) {
            return NextResponse.json({ error: "already_that_value" }, { status: 400 });
        }

        await auditConfigChange(db, {
            userId: accountId,
            actor: userId,
            scope: "profile_change_request",
            field,
            oldValue: current,
            newValue: requested,
        });

        const label = accountLabel(account, account.email);
        const code = account.client_code ?? accountId;
        const fieldLabel = field === "nif" ? "NIF" : "nome fiscal";

        // Best effort: the durable record is the audit row above. An email that
        // fails must not make the merchant think their request was refused.
        const mail = await callWorkerJson("/admin/notify", {
            method: "POST",
            body: JSON.stringify({
                recipients: [SUPPORT_EMAIL],
                subject: `[Rioko] ${code} pediu alteração de ${fieldLabel}`,
                body: [
                    `Cliente: ${label} (${code})`,
                    `Conta: ${accountId}`,
                    `Email: ${account.email ?? "—"}`,
                    "",
                    `Campo: ${fieldLabel}`,
                    `Actual: ${current || "—"}`,
                    `Pedido: ${requested}`,
                    note ? `\nNota do cliente:\n${note}` : "",
                    "",
                    `Ficha: https://rioko.online/admin/clientes/${code}`,
                ].join("\n"),
                from_name: "Rioko",
                reply_to: account.email ?? undefined,
            }),
        }).catch(() => ({ ok: false }));

        return NextResponse.json({ success: true, notified: mail.ok === true });
    } catch (error: any) {
        if (error?.name === "ReadOnlyMemberError") {
            return NextResponse.json({ error: "read_only_member" }, { status: 403 });
        }
        console.error("[user/identity-request] failed:", error?.message ?? error);
        return NextResponse.json({ error: "request_failed" }, { status: 500 });
    }
}
