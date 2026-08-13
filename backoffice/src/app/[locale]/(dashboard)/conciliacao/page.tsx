import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { resolveConnectionForUser } from "@/lib/worker";
import { isAdmin } from "@/lib/admin";
import { ReconciliationView } from "@/components/reconciliation/ReconciliationView";

export const runtime = "edge";
export const dynamic = "force-dynamic";

export default async function ConciliacaoPage() {
    const { userId } = await auth();
    if (!userId) redirect("/sign-in");

    // The impersonation cookie is only honoured for real admins — a client
    // could otherwise forge it and read another company's reconciliation.
    const cookieStore = await cookies();
    const impersonationId = cookieStore.get("rioko_impersonate_id")?.value;
    const viewerId = impersonationId && (await isAdmin(userId)) ? impersonationId : userId;

    const conn = await resolveConnectionForUser(viewerId);
    const t = await getTranslations("conciliacao");

    if (!conn) {
        return (
            <div className="max-w-3xl mx-auto px-6 py-10 sm:py-20 text-center">
                <h1 className="text-3xl font-medium mb-4">{t("title")}</h1>
                <p className="text-fg-60">
                    {t("noShop")}
                </p>
            </div>
        );
    }

    return <ReconciliationView identifier={conn.identifier} source={conn.source} destination={conn.destination} />;
}
