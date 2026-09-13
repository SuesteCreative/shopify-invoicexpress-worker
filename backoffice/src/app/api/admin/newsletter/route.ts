import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { isAdmin, isHiperadmin } from "@/lib/admin";
import { callWorkerJson } from "@/lib/worker";
import { resolveAudience, firstNameOf, FILTER_KEYS } from "@/lib/newsletter-audience";
import { fill, fillContactForTest, requiredLegalOk, unknownVars } from "@/lib/newsletter-template";

export const runtime = "edge";

/**
 * The newsletter page's one endpoint.
 *
 * Every action starts by resolving the audience from the filters, through the
 * same function, in this same file. That is the whole safety property: the count
 * an operator saw in the preview and the list that is actually mailed cannot
 * come from different code, because there is only one call site and the browser
 * never sends a list — only the filters that produce one. The two exceptions are
 * still keys: `user:<id>` for a client picked by hand, and `email:<address>` for
 * an address typed by the operator, both resolved in resolveAudience like the rest.
 *
 * Same code is not the same moment, though. A send carries the count the
 * operator was shown, and is refused when the audience resolved now is a
 * different size: somebody registered or cancelled between Simular and Enviar,
 * or the request did not come from a simulation at all. The panel's own gate is
 * a disabled button, which only the browser honours.
 *
 * Resend lives on the other side of callWorkerJson because the API key does.
 */

const db = () => (getRequestContext().env as any).DB as D1Database;

/**
 * The worker's reason, handed to the panel as it is ("Resend: Your plan includes
 * 3 segments"). Not a 502: sent from here, that status reached the browser as an
 * HTML error page in place of this JSON, and the panel could only say
 * "Unexpected token '<'".
 */
function workerFailed(status: number, data: unknown) {
    const reason = (data as any)?.error;
    return NextResponse.json(
        { error: typeof reason === "string" && reason ? reason : `O worker falhou (HTTP ${status})` },
        { status: 422 },
    );
}

export async function GET() {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const templates = await db()
        .prepare("SELECT slug, name, subject, preview_text, html, updated_at FROM newsletter_templates ORDER BY name")
        .all();
    const campaigns = await db()
        .prepare(`SELECT id, slug, subject, recipients, segment_id, broadcast_id,
                         scheduled_at, sent_by, created_at, filters_json
                  FROM newsletter_campaigns ORDER BY created_at DESC LIMIT 30`)
        .all();
    // The pick-by-hand list: what the empty filter resolves, so it offers exactly
    // the people a `user:` pick can reach, and nobody the base set leaves out.
    const clients = await resolveAudience(db(), []);

    return NextResponse.json({
        templates: templates.results ?? [],
        campaigns: campaigns.results ?? [],
        clients: clients.map(({ user_id, label, client_code, email }) => ({ user_id, label, client_code, email })),
        filter_keys: FILTER_KEYS,
    });
}

export async function POST(request: NextRequest) {
    try {
        const { userId } = await auth();
        // Writing to clients is hiperadmin work, as the dunning run is.
        if (!userId || !(await isHiperadmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await request.json().catch(() => ({})) as {
            action?: "preview" | "test" | "send";
            slug?: string;
            subject?: string;
            html?: string;
            preview_text?: string;
            filters?: string[];
            scheduled_at?: string;
            /** send only: the recipient count shown by the simulation. */
            confirm_count?: number;
        };

        const action = body.action ?? "preview";
        const slug = String(body.slug ?? "").trim();
        const rawSubject = String(body.subject ?? "").trim();
        const rawHtml = String(body.html ?? "");
        const rawPreview = String(body.preview_text ?? "").trim();
        const filters = Array.isArray(body.filters) ? body.filters.map(String) : [];

        if (!slug || !rawSubject || !rawHtml) {
            return NextResponse.json({ error: "Falta o template, o assunto ou o corpo" }, { status: 400 });
        }

        // Our placeholders resolve here, once, for the whole send. Resend's
        // triple-brace tags go through untouched — they are the per-recipient
        // half and the broadcast fills them.
        //
        // The subject and the inbox preview go through the same substitution as
        // the body. They are the two lines everybody reads and the only two the
        // preview pane does not render, so a stray {{GREETING_NAME}} there would
        // reach the whole list unseen, in the one place a broadcast cannot be
        // taken back.
        const html = fill(rawHtml);
        const subject = fill(rawSubject);
        const previewText = rawPreview ? fill(rawPreview) : undefined;
        const legal = requiredLegalOk(html);
        const missing = unknownVars([rawHtml, rawSubject, rawPreview].join("\n"));

        const recipients = await resolveAudience(db(), filters);

        if (action === "preview") {
            return NextResponse.json({
                count: recipients.length,
                recipients: recipients.slice(0, 500),
                html,
                // Resolved, so the two lines the iframe cannot render are still
                // read by a human before anything is sent.
                subject,
                preview_text: previewText ?? null,
                legal_error: legal,
                unknown_vars: missing,
            });
        }

        if (legal) {
            return NextResponse.json({ error: legal }, { status: 400 });
        }

        if (action === "test") {
            // Transactional, so it costs no broadcast and reaches the sender even
            // if they have unsubscribed. Resend fills {{{contact.*}}} only in a
            // Broadcast, so the greeting is filled here with the sender's first
            // name, from the same users.name the audience greets by. The
            // unsubscribe tag still renders literally: seeing it proves it
            // survived to the payload.
            // The primary address, not the first on the list: Clerk keeps them in
            // creation order, so [0] can be an old mailbox the admin no longer reads.
            const me = await currentUser();
            const to = me?.primaryEmailAddress?.emailAddress ?? me?.emailAddresses?.[0]?.emailAddress;
            if (!to) return NextResponse.json({ error: "Sem endereço para o teste" }, { status: 400 });
            const own = await db().prepare("SELECT name FROM users WHERE id = ?").bind(userId).first<{ name: string | null }>();
            const firstName = firstNameOf(own?.name || me?.firstName || "", "");

            const { ok, status, data } = await callWorkerJson("/admin/notify", {
                method: "POST",
                body: JSON.stringify({
                    recipients: [to],
                    subject: `[teste] ${fillContactForTest(subject, firstName)}`,
                    html: fillContactForTest(html, firstName),
                    from_name: "Rioko",
                }),
            });
            if (!ok) {
                console.error(`[admin/newsletter] test worker ${status}:`, JSON.stringify(data));
                return workerFailed(status, data);
            }
            console.warn(`[admin/newsletter] test "${slug}" to ${to} by ${userId}`);
            return NextResponse.json({ tested: to });
        }

        // action === "send"
        if (body.confirm_count !== recipients.length) {
            return NextResponse.json({
                error: typeof body.confirm_count === "number"
                    ? `Os destinatários mudaram desde a simulação (eram ${body.confirm_count}, agora são ${recipients.length}). Simula outra vez antes de enviar.`
                    : "Sem contagem confirmada. Simula outra vez antes de enviar.",
            }, { status: 409 });
        }
        if (recipients.length === 0) {
            return NextResponse.json({ error: "Nenhum destinatário para estes filtros" }, { status: 400 });
        }

        const { ok, status, data } = await callWorkerJson("/admin/newsletter/broadcast", {
            method: "POST",
            body: JSON.stringify({
                dry_run: false,
                slug,
                subject,
                html,
                preview_text: previewText,
                scheduled_at: body.scheduled_at,
                recipients: recipients.map((r) => ({
                    email: r.email, first_name: r.first_name, user_id: r.user_id,
                    label: r.label, client_code: r.client_code,
                })),
            }),
        });

        if (!ok) {
            console.error(`[admin/newsletter] worker ${status}:`, JSON.stringify(data));
            return workerFailed(status, data);
        }

        // Written after Resend answers, so a row here means it really went. The
        // resolved list is stored beside the filters because re-running the
        // filters next week returns a different set of people.
        const result = data as any;
        await db().prepare(`
            INSERT INTO newsletter_campaigns (
              id, slug, subject, filters_json, recipients_json, recipients,
              segment_id, broadcast_id, scheduled_at, sent_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
            crypto.randomUUID(),
            slug,
            subject,
            JSON.stringify(filters),
            // Code AND address. Filed under an email, a campaign can only ever
            // be traced to a mailbox; filed under the customer number it is
            // traceable to the account, which is the question anybody actually
            // asks afterwards. A TEXT column, so no migration.
            JSON.stringify(recipients.map((r) => ({ code: r.client_code, email: r.email }))),
            recipients.length,
            result?.segment_id ?? null,
            result?.broadcast_id ?? null,
            body.scheduled_at ?? null,
            userId,
        ).run();

        console.warn(`[admin/newsletter] SENT "${slug}" to ${recipients.length} by ${userId}`);
        return NextResponse.json(result);
    } catch (error: any) {
        console.error("[admin/newsletter] failed:", error?.message ?? error);
        return NextResponse.json({ error: "newsletter_failed" }, { status: 500 });
    }
}
