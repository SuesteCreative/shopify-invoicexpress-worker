import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { resolveShopForCurrentUser } from "@/lib/worker";
import { ReconciliationView } from "@/components/reconciliation/ReconciliationView";

export const dynamic = "force-dynamic";

export default async function ConciliacaoPage() {
    const { userId } = await auth();
    if (!userId) redirect("/sign-in");

    const shop = await resolveShopForCurrentUser(userId);

    if (!shop) {
        return (
            <div className="max-w-3xl mx-auto px-6 py-20 text-center">
                <h1 className="text-3xl font-black mb-4">Conciliação</h1>
                <p className="text-slate-400">
                    Ainda não tens uma integração Shopify ligada. Liga a tua loja primeiro para começares a conciliar faturas.
                </p>
            </div>
        );
    }

    return <ReconciliationView shop={shop} />;
}
