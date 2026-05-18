import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getDB } from "@/lib/stripe";
import { isAdmin } from "@/lib/admin";

export const runtime = "edge";

/**
 * Admin endpoint: set early_bird + trial_end for a specific user.
 * If no subscription row exists, creates one with status='trialing'.
 * If user already paid (stripe_subscription_id present), does NOT touch Stripe side
 * — only updates local early_bird/trial_end metadata.
 */
export async function POST(req: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId || !(await isAdmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = (await req.json()) as {
            user_id?: string;
            early_bird?: boolean;
            trial_end?: string | null;
        };
        const targetUserId = body.user_id;
        if (!targetUserId) return NextResponse.json({ error: "user_id required" }, { status: 400 });

        const db = getDB();

        const existing: any = await db.prepare(
            "SELECT user_id, status, stripe_subscription_id FROM subscriptions WHERE user_id = ?"
        ).bind(targetUserId).first();

        if (existing) {
            await db.prepare(`
                UPDATE subscriptions
                SET early_bird = ?, trial_end = ?, updated_at = CURRENT_TIMESTAMP
                WHERE user_id = ?
            `).bind(
                body.early_bird ? 1 : 0,
                body.trial_end || null,
                targetUserId,
            ).run();
        } else {
            await db.prepare(`
                INSERT INTO subscriptions (user_id, status, trial_end, early_bird, created_at, updated_at)
                VALUES (?, 'trialing', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `).bind(
                targetUserId,
                body.trial_end || null,
                body.early_bird ? 1 : 0,
            ).run();
        }

        const updated: any = await db.prepare(
            "SELECT user_id, status, trial_end, early_bird, stripe_subscription_id FROM subscriptions WHERE user_id = ?"
        ).bind(targetUserId).first();

        return NextResponse.json({ success: true, subscription: updated });
    } catch (e: any) {
        console.error("[admin/subscription] error", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function GET(req: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId || !(await isAdmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const targetUserId = req.nextUrl.searchParams.get("user_id");
        if (!targetUserId) return NextResponse.json({ error: "user_id required" }, { status: 400 });

        const db = getDB();
        const sub: any = await db.prepare(
            "SELECT * FROM subscriptions WHERE user_id = ?"
        ).bind(targetUserId).first();

        return NextResponse.json({ subscription: sub });
    } catch (e: any) {
        console.error("[admin/subscription GET] error", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
