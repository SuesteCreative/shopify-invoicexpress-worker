import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";

export const runtime = "edge";

export async function POST(request: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId || !(await isAdmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await request.json() as { targetId: string | null };
        const { targetId } = body;

        const response = NextResponse.json({ success: true });

        if (targetId) {
            // Set impersonation cookie for 1 day
            response.cookies.set("rioko_impersonate_id", targetId, {
                path: "/",
                httpOnly: true,
                secure: true,
                sameSite: "lax",
                maxAge: 86400
            });
        } else {
            // Clear impersonation
            response.cookies.delete("rioko_impersonate_id");
        }

        return response;
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
