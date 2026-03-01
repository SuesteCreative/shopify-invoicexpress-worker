import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

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
        const name = `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.username || "User";

        // Upsert user into DB. Don't overwrite role if it exists.
        await db.prepare(`
      INSERT INTO users (id, email, name, last_login)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        email = ?,
        name = ?,
        last_login = CURRENT_TIMESTAMP
    `).bind(userId, email, name, email, name).run();

        return NextResponse.json({ success: true });
    } catch (error: any) {
        console.error("Sync Error:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
