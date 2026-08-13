export const runtime = 'edge';
export const dynamic = 'force-dynamic';

import { getTranslations } from "next-intl/server";
import { getRole } from "@/lib/admin";
import { auth } from "@clerk/nextjs/server";
import { ImpersonationBanner } from "@/components/ImpersonationBanner";
import { IntegrationSetupModal } from "@/components/IntegrationSetupModal";
import { RIOKO_CONFIG } from "@/lib/config";
import { Sidebar } from "@/components/Sidebar";

export default async function DashboardLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const { userId } = await auth();

    // Admin nav follows the REAL role, never the impersonated one: impersonation
    // must not be able to grant it (a forged cookie pointing at a superadmin) nor
    // to take it away (an admin impersonating a client used to lose the sidebar
    // and with it the way back to /superadmin).
    const realRole = await getRole(userId);
    const canAccessAdmin = realRole === "superadmin" || realRole === "hiperadmin";
    const userIsHiperadmin = realRole === "hiperadmin";

    const t = await getTranslations("dashboardLayout");

    return (
        <div className="flex flex-col md:flex-row h-screen overflow-hidden">
            <ImpersonationBanner />
            <Sidebar
                canAccessAdmin={canAccessAdmin}
                isHiperadmin={userIsHiperadmin}
                version={RIOKO_CONFIG.version}
                isStable={RIOKO_CONFIG.stableBuild}
                strings={{
                    developedBy: t("developedBy"),
                    account: t("account"),
                    connected: t("connected"),
                    signOut: t("signOut"),
                    rights: t("rights"),
                    stableBuild: t("stableBuild"),
                    previewBuild: t("previewBuild"),
                    openMenu: t("openMenu"),
                    closeMenu: t("closeMenu"),
                }}
            />

            <main className="flex-1 overflow-y-auto relative z-10 px-4 py-6 md:px-12 md:py-16">
                {children}
            </main>

            <IntegrationSetupModal />
        </div>
    );
}
