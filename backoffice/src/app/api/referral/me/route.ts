import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { resolveAccountUser } from "@/lib/account";
import { accountLabel } from "@/lib/labels";
import { newReferralCode, referralLink, CAMPAIGN_END } from "@/lib/referral";

export const runtime = "edge";

/**
 * The merchant's own referral link, and what it has earned.
 *
 * The code is minted here, on the first view, rather than for every account up
 * front: most accounts will never open this page, and a code nobody has is a row
 * nobody needs. It is kept for ever afterwards, because it may already be in
 * somebody's inbox.
 */
export async function GET(request: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const db = (getRequestContext().env as any).DB as D1Database;
        const accountId = await resolveAccountUser(request, userId);

        let row: any = await db.prepare("SELECT code FROM referral_codes WHERE user_id = ?")
            .bind(accountId).first();

        if (!row) {
            const me: any = await db.prepare(
                "SELECT id, name, company_name, admin_label, email FROM users WHERE id = ?"
            ).bind(accountId).first();
            const code = newReferralCode(accountLabel(me, "cliente"));
            // OR IGNORE, then read back: two tabs opening this page at once must
            // not end with one of them holding a code that was never stored.
            await db.prepare("INSERT OR IGNORE INTO referral_codes (code, user_id) VALUES (?, ?)")
                .bind(code, accountId).run();
            row = await db.prepare("SELECT code FROM referral_codes WHERE user_id = ?")
                .bind(accountId).first();
        }

        const { results } = await db.prepare(`
            SELECT r.invitee_user_id, r.state, r.credit_cents, r.claimed_at, r.credited_at,
                   COALESCE(NULLIF(u.company_name,''), NULLIF(u.name,''), 'Conta convidada') AS label
              FROM referrals r
              LEFT JOIN users u ON u.id = r.invitee_user_id
             WHERE r.inviter_user_id = ?
             ORDER BY r.claimed_at DESC
        `).bind(accountId).all();

        const invites = (results ?? []) as any[];
        return NextResponse.json({
            code: row?.code ?? null,
            link: row?.code ? referralLink(row.code) : null,
            campaign_end: CAMPAIGN_END,
            invited: invites.length,
            paid: invites.filter((i) => i.state === "paid" || i.state === "credited").length,
            credited_cents: invites.reduce((s, i) => s + (i.credit_cents ?? 0), 0),
            invites: invites.map((i) => ({
                label: i.label,
                state: i.state,
                credit_cents: i.credit_cents,
                claimed_at: i.claimed_at,
            })),
        });
    } catch (error: any) {
        console.error("[referral/me] failed:", error?.message ?? error);
        return NextResponse.json({ error: "referral_failed" }, { status: 500 });
    }
}
