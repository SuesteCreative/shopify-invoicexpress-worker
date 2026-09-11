export const runtime = "edge";
export const dynamic = "force-dynamic";

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { isHiperadmin } from "@/lib/admin";
import { ClientRulesPanel } from "@/components/admin/ClientRulesPanel";

/**
 * The one route in this tree with a gate of its own, stricter than the layout's.
 *
 * Changing how a company invoices is hiperadmin work — the PATCH behind this
 * panel has always said so, and the merchant nav has only ever shown the link
 * to a hiperadmin. The old page gated on isSuperAdmin, which is the same
 * predicate as isAdmin, so a plain superadmin could read it by typing the URL.
 */
export default async function AdminClientRulesPage() {
    const { userId } = await auth();
    if (!(await isHiperadmin(userId))) redirect("/admin");

    return <ClientRulesPanel />;
}
