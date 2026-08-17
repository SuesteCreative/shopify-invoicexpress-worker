export const runtime = "edge";
export const dynamic = "force-dynamic";

import { auth } from "@clerk/nextjs/server";
import { isAdmin } from "@/lib/admin";
import { redirect } from "next/navigation";

// The middleware only checks for a session, and the dashboard layout merely
// hides the sidebar link — neither stops a plain user from typing the URL and
// getting the (empty) superadmin shell. The role check lives here so it covers
// the index and every sub-route, including the client-rendered page.tsx which
// cannot guard itself.
export default async function SuperadminLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        redirect("/dashboard");
    }

    return <>{children}</>;
}
