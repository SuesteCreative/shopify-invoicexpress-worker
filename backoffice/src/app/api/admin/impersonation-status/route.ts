import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getImpersonationId } from "@/lib/admin";

export const runtime = "edge";

export async function GET(request: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId || !(await isAdmin(userId))) {
            return NextResponse.json({ impersonating: false });
        }

        const impId = await getImpersonationId(request);
        if (!impId) return NextResponse.json({ impersonating: false });

        const { env } = getRequestContext();
        const db = (env as any).DB;

        const user: any = await db.prepare("SELECT email, name FROM users WHERE id = ?").bind(impId).first();

        if (!user) return NextResponse.json({ impersonating: false });

        return NextResponse.json({
            impersonating: true,
            user: {
                id: impId,
                name: user.name,
                email: user.email
            }
        });

    } catch (error: any) {
        return NextResponse.json({ impersonating: false }, { status: 500 });
    }
}
