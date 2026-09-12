import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { isHiperadmin } from "@/lib/admin";

export const runtime = "edge";

/** Save a newsletter template. Editable without a deploy, which is the only
 *  reason these live in D1 and not in a file. */
export async function PUT(request: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId || !(await isHiperadmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await request.json().catch(() => ({})) as {
            slug?: string; name?: string; subject?: string;
            preview_text?: string; html?: string;
        };

        const slug = String(body.slug ?? "").trim().toLowerCase();
        // The slug names a Resend segment and broadcast, so keep it to what is
        // safe in a name and recognisable in their dashboard.
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 40) {
            return NextResponse.json({ error: "Slug inválido" }, { status: 400 });
        }
        if (!body.subject?.trim() || !body.html?.trim()) {
            return NextResponse.json({ error: "Falta o assunto ou o corpo" }, { status: 400 });
        }

        const db = (getRequestContext().env as any).DB as D1Database;
        await db.prepare(`
            INSERT INTO newsletter_templates (slug, name, subject, preview_text, html, updated_by, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(slug) DO UPDATE SET
              name = excluded.name, subject = excluded.subject,
              preview_text = excluded.preview_text, html = excluded.html,
              updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP
        `).bind(
            slug,
            String(body.name ?? slug).trim().slice(0, 120),
            body.subject.trim().slice(0, 300),
            body.preview_text?.trim().slice(0, 300) ?? null,
            body.html,
            userId,
        ).run();

        console.warn(`[admin/newsletter] template "${slug}" saved by ${userId}`);
        return NextResponse.json({ slug });
    } catch (error: any) {
        console.error("[admin/newsletter/template] failed:", error?.message ?? error);
        return NextResponse.json({ error: "template_save_failed" }, { status: 500 });
    }
}
