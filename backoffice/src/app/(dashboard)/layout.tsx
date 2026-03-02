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
            <aside className="w-full md:w-72 glass border-r-0 md:border-r border-slate-800/60 p-8 flex flex-col items-center md:items-start shrink-0 z-20 md:sticky md:top-0 h-screen overflow-y-auto scrollbar-hide">
                <div className="mb-14 flex flex-col items-center md:items-start w-full">
                    <div className="flex items-end gap-3 transition-transform hover:scale-[1.02]">
                        <Link href="/" className="pb-1">
                            <Image
                                src="/images/logo-rioko-white.svg"
                                alt="Rioko Logo"
                                width={110}
                                height={28}
                                priority
                            />
                        </Link>
                        <span className="text-sky-400 bg-sky-400/10 px-1.5 py-0.5 rounded text-[10px] font-black tracking-tighter border border-sky-400/20 mb-1 align-bottom">2.0</span>
                    </div>

                    <div className="mt-4 flex flex-col items-start gap-1">
                        <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest opacity-60">Developed by</div>
                        <a href="https://kapta.pt" target="_blank" rel="noopener noreferrer" className="transition-all hover:scale-105 active:scale-95">
                            <Image src="/images/logo-kapta-white.webp" alt="Kapta Logo" width={70} height={18} className="opacity-40 grayscale hover:opacity-100 hover:grayscale-0 transition-all duration-500" />
                        </a>
                    </div>
                </div>

                <NavLinks canAccessAdmin={canAccessAdmin} isHiperadmin={userIsHiperadmin} />

                <div className="mt-auto space-y-4 w-full pt-8">
                    <div className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-slate-800/50 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <UserButton afterSignOutUrl="/" />
                            <div className="flex flex-col">
                                <span className="text-[10px] font-black text-white uppercase tracking-wider">Conta</span>
                                <span className="text-[9px] text-slate-500 font-bold uppercase truncate max-w-[100px]">Ligado</span>
                            </div>
                        </div>
                        <SignOutButton>
                            <button className="p-2 rounded-lg hover:bg-rose-500/10 text-slate-500 hover:text-rose-500 transition-all cursor-pointer">
                                <LogOut className="w-4 h-4" />
                            </button>
                        </SignOutButton>
                    </div>

                    <div className="pt-6 border-t border-slate-800/50 w-full text-center md:text-left space-y-1">
                        <div className="text-[10px] text-slate-500 font-bold whitespace-nowrap">© 2026 Kapta. Todos os direitos reservados.</div>
                        <div className="text-[9px] text-slate-700 font-black tracking-widest uppercase">v{RIOKO_CONFIG.version} {RIOKO_CONFIG.stableBuild ? "Stable Build" : "Preview Build"}</div>
                    </div>
                </div>
            </aside>

            {/* Main Content Area */}
            <main className="flex-1 overflow-y-auto relative z-10 px-6 py-10 md:px-12 md:py-16">
                {children}
            </main>
        </div>
    );
}
