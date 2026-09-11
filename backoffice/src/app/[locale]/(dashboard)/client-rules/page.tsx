import { auth } from "@clerk/nextjs/server";
import { isHiperadmin } from "@/lib/admin";
import { redirect } from "next/navigation";
import { ClientRulesPanel } from "@/components/admin/ClientRulesPanel";

export const runtime = "edge";
export const dynamic = "force-dynamic";

/**
 * Server gate. The page was previously a bare client component that relied on
 * the nav hiding its link — which is not a permission check, only a decoration.
 * The API routes were guarded, so nothing leaked, but the page itself rendered
 * for anyone who typed the URL.
 *
 * Now hiperadmin, which is what the nav has always advertised and what the only
 * verb that writes here already requires. It used to say isSuperAdmin, a
 * predicate identical to isAdmin, so a plain superadmin could read the page by
 * typing the URL while never being shown the link.
 */
export default async function ClientRulesPage() {
  const { userId } = await auth();
  if (!(await isHiperadmin(userId))) {
    redirect("/dashboard");
  }

  return <ClientRulesPanel />;
}
