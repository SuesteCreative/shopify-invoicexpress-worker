import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

export const runtime = 'edge';

export async function GET() {
    const { userId } = await auth();
    if (!userId) return new NextResponse("Unauthorized", { status: 401 });

    const { env } = getRequestContext();
    const db = (env as any).DB;

    const user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
    return NextResponse.json(user);
}

interface UserProfileData {
    nif: string;
    company_name?: string;
    fiscal_address: string;
    phone?: string;
    website?: string;
    privacy_policy_accepted: boolean;
}

export async function POST(req: Request) {
    const { userId } = await auth();
    if (!userId) return new NextResponse("Unauthorized", { status: 401 });

    const data: UserProfileData = await req.json();
    const { env } = getRequestContext();
    const db = (env as any).DB;

    await db.prepare(`
        UPDATE users 
        SET nif = ?, 
            company_name = ?, 
            fiscal_address = ?, 
            phone = ?, 
            website = ?, 
            registration_completed = 1, 
            privacy_policy_accepted = ?
        WHERE id = ?
    `).bind(
        data.nif,
        data.company_name,
        data.fiscal_address,
        data.phone,
        data.website,
        data.privacy_policy_accepted ? 1 : 0,
        userId
    ).run();

    return NextResponse.json({ success: true });
}
