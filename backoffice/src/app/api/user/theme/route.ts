import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { THEMES, type Theme } from "@/lib/theme";

export const runtime = "edge";

/**
 * POST /api/user/theme
 * Records which skin the account picked, so the emails we send them can be
 * dressed the same way.
 *
 * The dashboard keeps painting itself from localStorage and never asks the
 * server what to render — that is what makes the toggle instant and keeps the
 * theme out of everything the app decides. This row is a copy of the choice,
 * read only when an email is rendered.
 *
 * Fire-and-forget by design: the caller does not wait for it and nothing on
 * screen depends on it. A failure here costs the account an email in the other
 * skin, nothing more.
 */
export async function POST(req: Request) {
    const { userId } = await auth();
    if (!userId) return new NextResponse("Unauthorized", { status: 401 });

    const body = (await req.json().catch(() => ({}))) as { theme?: string };
    const theme = body.theme as Theme;
    if (!THEMES.includes(theme)) {
        return NextResponse.json({ error: "Unknown theme" }, { status: 400 });
    }

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "No database" }, { status: 500 });

    await db.prepare("UPDATE users SET theme = ? WHERE id = ?").bind(theme, userId).run();
    return NextResponse.json({ ok: true, theme });
}
