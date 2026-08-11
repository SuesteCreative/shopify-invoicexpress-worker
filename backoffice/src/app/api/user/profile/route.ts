import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getImpersonationId } from "@/lib/admin";

export const runtime = 'edge';

// The registration form is often filled in by an admin while impersonating the
// client (support call, onboarding). The dashboard reads the *impersonated*
// user's row to decide whether to show the form, so the write has to land on
// the same row — otherwise the admin overwrites their own profile and the
// client sees the empty form again on every login.
async function resolveTargetUser(request: NextRequest, userId: string) {
    if (!(await isAdmin(userId))) return userId;
    const impersonationId = await getImpersonationId(request);
    return impersonationId || userId;
}

export async function GET(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return new NextResponse("Unauthorized", { status: 401 });

    const targetUserId = await resolveTargetUser(request, userId);

    const { env } = getRequestContext();
    const db = (env as any).DB;

    const user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(targetUserId).first();
    return NextResponse.json(user);
}

interface UserProfileData {
    nif: string;
    name?: string;
    company_name?: string;
    fiscal_address: string;
    phone?: string;
    website?: string;
    privacy_policy_accepted: boolean;
}

export async function POST(req: NextRequest) {
    const { userId } = await auth();
    if (!userId) return new NextResponse("Unauthorized", { status: 401 });

    const targetUserId = await resolveTargetUser(req, userId);

    const data: UserProfileData = await req.json();
    const { env } = getRequestContext();
    const db = (env as any).DB;

    const result = await db.prepare(`
        UPDATE users
        SET nif = ?,
            name = COALESCE(NULLIF(?, ''), name),
            company_name = ?,
            fiscal_address = ?,
            phone = ?,
            website = ?,
            registration_completed = 1,
            privacy_policy_accepted = ?
        WHERE id = ?
    `).bind(
        data.nif,
        (data.name || "").trim(),
        data.company_name,
        data.fiscal_address,
        data.phone,
        data.website,
        data.privacy_policy_accepted ? 1 : 0,
        targetUserId
    ).run();

    // No row for this id: the Clerk → D1 sync never ran. Saying "success" here
    // is what made the form come back empty on the next login.
    if (result?.meta?.changes === 0) {
        console.error(`[profile] No users row for ${targetUserId} — profile not saved`);
        return NextResponse.json({ error: "user_row_missing" }, { status: 409 });
    }

    return NextResponse.json({ success: true, user_id: targetUserId });
}
