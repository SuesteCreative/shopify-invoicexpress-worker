import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

export const runtime = "edge";

/** Cap stored strings so a crafted referrer/UTM can't bloat the row. */
function clip(v: unknown, max = 512): string | null {
    if (typeof v !== "string") return null;
    const s = v.trim();
    return s ? s.slice(0, max) : null;
}

/**
 * POST /api/user/attribution
 * First-touch acquisition write. Called once from the browser after sign-in with
 * the values captured into the `rioko_attr` cookie on the user's first visit.
 * Country comes from the user's own request (cf-ipcountry), not the cookie.
 * Idempotent: the UPDATE only fills the row while acq_captured_at IS NULL.
 */
export async function POST(req: Request) {
    const { userId } = await auth();
    if (!userId) return new NextResponse("Unauthorized", { status: 401 });

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const country = clip(req.headers.get("cf-ipcountry"), 8);

    const { env } = getRequestContext();
    const db = (env as any).DB;

    await db
        .prepare(
            `UPDATE users SET
                acq_referrer = ?,
                acq_utm_source = ?,
                acq_utm_medium = ?,
                acq_utm_campaign = ?,
                acq_landing = ?,
                acq_click_id = ?,
                acq_country = ?,
                acq_captured_at = CURRENT_TIMESTAMP
             WHERE id = ? AND acq_captured_at IS NULL`
        )
        .bind(
            clip(body.referrer),
            clip(body.utm_source, 128),
            clip(body.utm_medium, 128),
            clip(body.utm_campaign, 128),
            clip(body.landing),
            clip(body.click_id, 256),
            country,
            userId
        )
        .run();

    return NextResponse.json({ success: true });
}
