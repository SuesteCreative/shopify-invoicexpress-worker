import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isHiperadmin, isSuperAdmin } from "@/lib/admin";

export const runtime = "edge";

/**
 * GET /api/admin/client-rules — return integration settings and custom flags for all visible clients
 * PATCH /api/admin/client-rules — update a specific flag for a client
 */
export async function GET(request: NextRequest) {
    const { userId } = await auth();
    if (!userId || !(await isSuperAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { env } = getRequestContext();
    const db = (env as any).DB;

    const rows = await db.prepare(`
        SELECT u.id, u.name, u.email,
            i.shopify_domain, i.ix_account_name, i.ix_environment,
            i.vat_included, i.auto_finalize, i.ix_exemption_reason,
            i.pos_mode, i.client_sync, i.webhooks_active, i.shopify_authorized, i.ix_authorized,
            i.shopify_forced_at, i.webhooks_forced_at, i.ix_forced_at
        FROM users u
        INNER JOIN integrations i ON u.id = i.user_id
        ORDER BY u.name ASC
    `).all();

    return NextResponse.json(rows.results);
}

export async function PATCH(request: NextRequest) {
    const { userId } = await auth();
    // Only hiperadmin can change custom flags (superadmins can read but not change)
    if (!userId || !(await isHiperadmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { targetUserId, flag, value } = await request.json() as { targetUserId: string; flag: string; value: number };

    // Whitelist of toggleable flags
    const allowedFlags = ["pos_mode", "client_sync", "vat_included", "auto_finalize", "webhooks_active", "shopify_authorized", "ix_authorized"];
    if (!allowedFlags.includes(flag)) {
        return NextResponse.json({ error: "Flag not allowed" }, { status: 400 });
    }

    const { env } = getRequestContext();
    const db = (env as any).DB;

    // If it's a force flag, we also update the timestamp
    const forceFlags = ["shopify_authorized", "webhooks_active", "ix_authorized"];
    if (forceFlags.includes(flag)) {
        const dateFlag = flag.replace("_authorized", "_forced_at").replace("webhooks_active", "webhooks_forced_at");
        if (value === 1) {
            await db.prepare(`UPDATE integrations SET ${flag} = ?, ${dateFlag} = CURRENT_TIMESTAMP WHERE user_id = ?`).bind(value, targetUserId).run();
        } else {
            await db.prepare(`UPDATE integrations SET ${flag} = ?, ${dateFlag} = NULL WHERE user_id = ?`).bind(value, targetUserId).run();
        }
    } else {
        await db.prepare(`UPDATE integrations SET ${flag} = ? WHERE user_id = ?`).bind(value, targetUserId).run();
    }

    return NextResponse.json({ success: true });
}
