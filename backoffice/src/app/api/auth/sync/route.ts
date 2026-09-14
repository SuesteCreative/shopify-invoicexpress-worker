import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { upsertUserRow } from "@/lib/client-code";

export const runtime = "edge";

export async function POST() {
    try {
        const { userId } = await auth();
        const user = await currentUser();

        if (!userId || !user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { env } = getRequestContext();
        const db = (env as any).DB;

        const email = user.emailAddresses?.[0]?.emailAddress || null;
        // No "User" fallback — see the Clerk webhook and lib/client-code.
        const name = `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.username || null;

        // Upsert the user, role untouched, with the customer number that comes
        // with a new row. Shared with the Clerk webhook so there is exactly one
        // statement that creates an account — see lib/client-code.
        await upsertUserRow(db, { id: userId, email, name });


        return NextResponse.json({ success: true });
    } catch (error: any) {
        console.error("Sync Error:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
