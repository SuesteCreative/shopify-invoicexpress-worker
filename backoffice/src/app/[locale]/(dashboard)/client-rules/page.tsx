import { auth } from "@clerk/nextjs/server";
import { isSuperAdmin } from "@/lib/admin";
import { redirect } from "next/navigation";
import { ClientRulesPanel } from "./ClientRulesPanel";

export const runtime = "edge";
export const dynamic = "force-dynamic";

/**
 * Server gate. The page was previously a bare client component that relied on
 * the nav hiding its link — which is not a permission check, only a decoration.
 * The API routes were guarded, so nothing leaked, but the page itself rendered
 * for anyone who typed the URL.
 */
export default async function ClientRulesPage() {
  const { userId } = await auth();
  if (!userId || !(await isSuperAdmin(userId))) {
    redirect("/dashboard");
  }

  return <ClientRulesPanel />;
}
