export const runtime = "edge";
export const dynamic = "force-dynamic";

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { isHiperadmin } from "@/lib/admin";
import { NewsletterPanel } from "@/components/admin/NewsletterPanel";

/**
 * Its own gate, stricter than the layout's, like /admin/client-rules.
 *
 * Writing to every client at once is the least reversible thing this surface can
 * do: a badly aimed newsletter cannot be recalled, corrected or deleted, and it
 * arrives in the inbox of people who pay us. The route behind it is hiperadmin
 * too, so this only stops a plain superadmin from reading the page by typing the
 * URL and finding a send button.
 */
export default async function AdminNewsletterPage() {
    const { userId } = await auth();
    if (!(await isHiperadmin(userId))) redirect("/admin");

    return <NewsletterPanel />;
}
