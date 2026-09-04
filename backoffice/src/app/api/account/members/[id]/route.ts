import { NextRequest, NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { getAccountContext, getAccountDB } from "@/lib/account";

export const runtime = "edge";

const VALID_ROLES = new Set(["admin", "viewer"]);

async function load(req: NextRequest, memberId: string) {
    const ctx = await getAccountContext(req);
    if (!ctx) return { error: "Unauthorized", status: 401 as const };
    if (ctx.access === "viewer") return { error: "read_only", status: 403 as const };

    const db = getAccountDB();
    if (!db) return { error: "Database binding missing", status: 500 as const };

    const member: any = await db
        .prepare("SELECT * FROM account_members WHERE id = ? AND account_id = ?")
        .bind(memberId, ctx.accountId)
        .first();
    if (!member) return { error: "not_found", status: 404 as const };

    return { ctx, db, member };
}

/** PATCH /api/account/members/:id — change a member's permission level. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;
        const loaded = await load(req, id);
        if ("error" in loaded) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
        const { db, ctx, member } = loaded;

        const body = (await req.json().catch(() => ({}))) as { role?: string };
        const role = String(body.role ?? "");
        if (!VALID_ROLES.has(role)) return NextResponse.json({ error: "invalid_role" }, { status: 400 });

        await db.prepare("UPDATE account_members SET role = ? WHERE id = ?").bind(role, member.id).run();

        // Keep the Clerk claim in step: middleware reads it to block writes for
        // read-only members without a database round-trip.
        if (member.member_user_id) {
            try {
                const clerk = await clerkClient();
                await clerk.users.updateUserMetadata(member.member_user_id, {
                    publicMetadata: { rioko_account_id: ctx.accountId, rioko_role: role },
                });
            } catch (e: any) {
                console.warn("[account/members] metadata update failed:", e?.message ?? e);
            }
        }

        return NextResponse.json({ ok: true, role });
    } catch (e: any) {
        console.error("[account/members] PATCH", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

/** DELETE /api/account/members/:id — revoke access. The seat was a one-off
 *  charge, so nothing is refunded and re-inviting the same address bills again. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;
        const loaded = await load(req, id);
        if ("error" in loaded) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
        const { db, member } = loaded;

        await db
            .prepare("UPDATE account_members SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(member.id)
            .run();

        const clerk = await clerkClient();
        if (member.status === "pending" && member.clerk_invitation_id) {
            try { await clerk.invitations.revokeInvitation(member.clerk_invitation_id); } catch { /* already used or expired */ }
        }
        if (member.member_user_id) {
            try {
                await clerk.users.updateUserMetadata(member.member_user_id, {
                    publicMetadata: { rioko_account_id: null, rioko_role: null },
                });
            } catch (e: any) {
                console.warn("[account/members] metadata clear failed:", e?.message ?? e);
            }
        }

        return NextResponse.json({ ok: true });
    } catch (e: any) {
        console.error("[account/members] DELETE", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
