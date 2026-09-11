import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getDB, getStripe } from "@/lib/stripe";
import { isAdmin } from "@/lib/admin";
import { RIOKO_CONFIG } from "@/lib/config";
import { invitePath, isPairInvitable, newInviteToken } from "@/lib/onboarding-invites";
import { tierOf } from "@/lib/billing-legacy";

export const runtime = "edge";

/**
 * Admin: the onboarding link handed to one client, with the payment settled.
 *
 * Creating one does not touch Stripe or the subscriptions table. It records an
 * intention: when somebody signs up through this link, the subscription named
 * here starts paying for this pair. The move happens at claim time, in
 * /api/onboarding/invite/claim, because before that there is no account to
 * attach anything to.
 */

const DEFAULT_VALID_DAYS = 30;

export async function GET() {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    const db = getDB();
    const rows = await db
        .prepare(
            `SELECT i.*, u.company_name AS claimed_company, u.email AS claimed_email
               FROM onboarding_invites i
               LEFT JOIN users u ON u.id = i.claimed_by_user_id
              ORDER BY i.created_at DESC
              LIMIT 50`
        )
        .all()
        .catch(() => ({ results: [] as any[] }));

    const invites = ((rows as any).results ?? []).map((r: any) => ({
        ...r,
        url: invitePath(r) ? `${RIOKO_CONFIG.appUrl}/pt${invitePath(r)}` : null,
    }));
    return NextResponse.json({ invites });
}

export async function POST(req: NextRequest) {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    const body = (await req.json().catch(() => ({}))) as {
        label?: string;
        source_kind?: string;
        destination_kind?: string;
        stripe_subscription_id?: string;
        note?: string;
        valid_days?: number;
    };

    const label = (body.label ?? "").trim();
    const subscriptionId = (body.stripe_subscription_id ?? "").trim();
    if (!label) return NextResponse.json({ error: "label is required" }, { status: 400 });
    if (!subscriptionId.startsWith("sub_")) {
        return NextResponse.json({ error: "stripe_subscription_id must be a Stripe subscription id (sub_…)" }, { status: 400 });
    }
    // A pair with no guided page has nowhere to send the client, so the link
    // would be a 404 with a promise attached.
    if (!isPairInvitable(body.source_kind, body.destination_kind)) {
        return NextResponse.json({ error: "that pair has no guided onboarding" }, { status: 400 });
    }

    // The subscription has to exist, and we note which connection it pays for
    // today so the claim can close that row when it moves.
    const stripe = getStripe();
    let sub: any;
    try {
        // Expanded: the price is what says whether this client is on the old
        // plan, and the operator should know that before sending the link.
        sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["items.data.price"] });
    } catch (e: any) {
        return NextResponse.json({ error: `Stripe subscription not found: ${e.message}` }, { status: 404 });
    }
    if (sub.status === "canceled" || sub.status === "incomplete_expired") {
        return NextResponse.json({ error: `that subscription is ${sub.status}` }, { status: 400 });
    }

    const db = getDB();
    const current: any = await db
        .prepare("SELECT connection_key FROM subscriptions WHERE stripe_subscription_id = ? LIMIT 1")
        .bind(subscriptionId)
        .first()
        .catch(() => null);

    const days = Number.isFinite(body.valid_days) && (body.valid_days as number) > 0
        ? Math.min(Math.floor(body.valid_days as number), 365)
        : DEFAULT_VALID_DAYS;
    const expiresAt = new Date(Date.now() + days * 86400_000).toISOString();
    const token = newInviteToken(label);

    await db
        .prepare(
            `INSERT INTO onboarding_invites
               (token, label, source_kind, destination_kind, stripe_subscription_id,
                from_connection_key, note, created_by, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
            token,
            label,
            body.source_kind,
            body.destination_kind,
            subscriptionId,
            current?.connection_key ?? (sub.metadata?.connection_key ?? null),
            (body.note ?? "").trim() || null,
            userId,
            expiresAt,
        )
        .run();

    const path = invitePath({ source_kind: body.source_kind!, destination_kind: body.destination_kind!, token });
    return NextResponse.json({
        ok: true,
        token,
        // 5 €/50 €. The client keeps it, and the claim marks the row so every
        // admin surface says so without having to work it out.
        legacy_price: tierOf(sub.items?.data?.[0]?.price) === "legacy",
        expires_at: expiresAt,
        url: `${RIOKO_CONFIG.appUrl}/pt${path}`,
        url_en: `${RIOKO_CONFIG.appUrl}/en${path}`,
    });
}
