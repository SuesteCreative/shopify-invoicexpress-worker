import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { resolveShopForUser } from "@/lib/worker";
import { ReconciliationView } from "@/components/reconciliation/ReconciliationView";

export const runtime = "edge";
export const dynamic = "force-dynamic";

export default async function ConciliacaoPage() {
    const { userId } = await auth();
    if (!userId) redirect("/sign-in");

    const cookieStore = await cookies();
    const impersonationId = cookieStore.get("rioko_impersonate_id")?.value;
    const viewerId = impersonationId || userId;

    const shop = await resolveShopForUser(viewerId);
    const t = await getTranslations("conciliacao");

    if (!shop) {
        return (
            <div className="max-w-3xl mx-auto px-6 py-20 text-center">
                <h1 className="text-3xl font-medium mb-4">{t("title")}</h1>
                <p className="text-fg-60">
                    {t("noShop")}
                </p>
            </div>
        );
    }

    return <ReconciliationView shop={shop} />;
}
