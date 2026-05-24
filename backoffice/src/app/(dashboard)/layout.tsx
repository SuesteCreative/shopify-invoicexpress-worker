import { UserButton, SignOutButton } from "@clerk/nextjs";
export const runtime = 'edge';
export const dynamic = 'force-dynamic';
import Image from "next/image";
import Link from "next/link";
import { LogOut, Activity, ShieldCheck } from "lucide-react";
import { isAdmin, isHiperadmin, getRole } from "@/lib/admin";
import { auth } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { ImpersonationBanner } from "@/components/ImpersonationBanner";
import { IntegrationSetupModal } from "@/components/IntegrationSetupModal";
import { RIOKO_CONFIG } from "@/lib/config";
import { NavLinks } from "@/components/NavLinks";

export default async function DashboardLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const { userId } = await auth();
    const isSuperAdmin = await isAdmin(userId);

    // Determine the viewer's role (account for impersonation)
    // When impersonating, sidebar shows the IMPERSONATED user's permissions, not the real admin's.
    const cookieStore = await cookies();
    const impersonationId = cookieStore.get("rioko_impersonate_id")?.value;
    const viewerUserId = impersonationId || userId;
    const viewerRole = await getRole(viewerUserId);
    const canAccessAdmin = viewerRole === "superadmin" || viewerRole === "hiperadmin";
    const userIsHiperadmin = viewerRole === "hiperadmin";

    return (
        <div className="flex flex-col md:flex-row h-screen overflow-hidden">
            <ImpersonationBanner />
            {/* Sidebar */}
            <aside className="w-full md:w-72 glass border-r-0 md:border-r border-hairline p-8 flex flex-col items-center md:items-start shrink-0 z-20 md:sticky md:top-0 h-screen overflow-y-auto scrollbar-hide">
                <div className="mb-14 flex flex-col items-center md:items-start w-full">
                    <div className="flex items-center transition-transform hover:scale-[1.02]">
                        <Link href="/">
                            <Image
                                src="/images/rioko2-logo.svg"
                                alt="Rioko 2.0"
                                width={140}
                                height={29}
                                priority
                            />
                        </Link>
                    </div>

                    <div className="mt-4 flex flex-col items-start gap-1">
                        <div className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">Developed by</div>
                        <a href="https://kapta.pt" target="_blank" rel="noopener noreferrer" className="transition-all hover:scale-105 active:scale-95">
                            <Image src="/images/logo-kapta-white.webp" alt="Kapta Logo" width={70} height={18} className="opacity-40 grayscale hover:opacity-100 hover:grayscale-0 transition-all duration-500" />
                        </a>
                    </div>
                </div>

                <NavLinks canAccessAdmin={canAccessAdmin} isHiperadmin={userIsHiperadmin} />

                <div className="mt-auto space-y-4 w-full pt-8">
                    <div className="px-4 py-3 rounded-2xl bg-surface-2 border border-hairline flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <UserButton afterSignOutUrl="/" />
                            <div className="flex flex-col">
                                <span className="font-mono text-[10px] text-fg uppercase tracking-[0.18em]">Conta</span>
                                <span className="font-mono text-[9px] text-fg-40 uppercase truncate max-w-[100px]">Ligado</span>
                            </div>
                        </div>
                        <SignOutButton>
                            <button
                                className="p-2 rounded-lg text-fg-40 transition-all cursor-pointer hover:bg-[rgba(244,63,94,0.10)] hover:text-destructive"
                            >
                                <LogOut className="w-4 h-4" />
                            </button>
                        </SignOutButton>
                    </div>

                    <div className="pt-6 border-t border-hairline w-full text-center md:text-left space-y-1">
                        <div className="font-mono text-[10px] text-fg-40 whitespace-nowrap tracking-[0.18em]">© 2026 Kapta. Todos os direitos reservados.</div>
                        <div className="font-mono text-[9px] text-fg-40 tracking-[0.22em] uppercase">v{RIOKO_CONFIG.version} {RIOKO_CONFIG.stableBuild ? "Stable Build" : "Preview Build"}</div>
                    </div>
                </div>
            </aside>

            {/* Main Content Area */}
            <main className="flex-1 overflow-y-auto relative z-10 px-6 py-10 md:px-12 md:py-16">
                {children}
            </main>

            {/* Floating modal: shown for users with incomplete integration */}
            <IntegrationSetupModal />
        </div>
    );
}
