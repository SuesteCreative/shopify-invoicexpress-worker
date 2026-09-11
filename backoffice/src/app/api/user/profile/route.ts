import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/account";
import { isDestinationKind, isSourceKind } from "@/lib/connection-kinds";

export const runtime = 'edge';

// The registration form is often filled in by an admin while impersonating the
// client (support call, onboarding). The dashboard reads the *impersonated*
// user's row to decide whether to show the form, so the write has to land on
// the same row — otherwise the admin overwrites their own profile and the
// client sees the empty form again on every login.
async function resolveTargetUser(request: NextRequest, userId: string) {
    return resolveAccountUser(request, userId);
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
    /** The pair picked in the general onboarding. Absent means "leave as is". */
    onboarding_source_kind?: string | null;
    onboarding_destination_kind?: string | null;
}

export async function POST(req: NextRequest) {
    const { userId } = await auth();
    if (!userId) return new NextResponse("Unauthorized", { status: 401 });

    const targetUserId = await resolveTargetUser(req, userId);

    const data: UserProfileData = await req.json();
    const { env } = getRequestContext();
    const db = (env as any).DB;

    // An intention, not a connection — but it is written to the client's record,
    // so it may only ever hold a kind the rest of the system recognises.
    const source = data.onboarding_source_kind ?? null;
    const destination = data.onboarding_destination_kind ?? null;
    if (source !== null && !isSourceKind(source)) {
        return NextResponse.json({ error: "invalid_source_kind" }, { status: 400 });
    }
    if (destination !== null && !isDestinationKind(destination)) {
        return NextResponse.json({ error: "invalid_destination_kind" }, { status: 400 });
    }

    const accepted = data.privacy_policy_accepted ? 1 : 0;

    // `privacy_policy_accepted_at` is stamped on the FIRST acceptance and never
    // moved afterwards: a consent that re-dates itself every time the merchant
    // corrects their address records nothing. COALESCE on the two onboarding
    // columns is the opposite on purpose — re-running the onboarding with a
    // different pair should say so, and a request that omits them changes them
    // back to nothing.
    const bind = (sql: string, extra: unknown[]) => db.prepare(sql).bind(
        data.nif,
        (data.name || "").trim(),
        data.company_name,
        data.fiscal_address,
        data.phone,
        data.website,
        accepted,
        ...extra,
        targetUserId,
    ).run();

    const COLUMNS = `
        SET nif = ?,
            name = COALESCE(NULLIF(?, ''), name),
            company_name = ?,
            fiscal_address = ?,
            phone = ?,
            website = ?,
            registration_completed = 1,
            privacy_policy_accepted = ?`;

    const result = await bind(`
        UPDATE users${COLUMNS},
            privacy_policy_accepted_at = CASE
                WHEN ? = 1 THEN COALESCE(privacy_policy_accepted_at, CURRENT_TIMESTAMP)
                ELSE privacy_policy_accepted_at END,
            onboarding_source_kind = COALESCE(?, onboarding_source_kind),
            onboarding_destination_kind = COALESCE(?, onboarding_destination_kind)
        WHERE id = ?
    `, [accepted, source, destination])
        // Migration 0049 is applied by hand (d1_migrations is frozen), so the
        // deploy can land before the columns do. The profile still has to save.
        .catch(async (e: any) => {
            console.warn("[profile] pre-0049 users table, saving without the onboarding columns:", e?.message);
            return bind(`UPDATE users${COLUMNS} WHERE id = ?`, []);
        });

    // No row for this id: the Clerk → D1 sync never ran. Saying "success" here
    // is what made the form come back empty on the next login.
    if (result?.meta?.changes === 0) {
        console.error(`[profile] No users row for ${targetUserId} — profile not saved`);
        return NextResponse.json({ error: "user_row_missing" }, { status: 409 });
    }

    return NextResponse.json({ success: true, user_id: targetUserId });
}
