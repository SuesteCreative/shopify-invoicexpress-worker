import { UserButton, SignOutButton } from "@clerk/nextjs";
import Image from "next/image";
import Link from "next/link";
import { LogOut, Activity, CreditCard, ShieldCheck } from "lucide-react";
import { isAdmin } from "@/lib/admin";
import { auth } from "@clerk/nextjs/server";
import { ImpersonationBanner } from "@/components/ImpersonationBanner";
import { RIOKO_CONFIG } from "@/lib/config";

export default async function DashboardLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const { userId } = await auth();
    const isSuperAdmin = await isAdmin(userId);

    return (
        <div className="flex flex-col md:flex-row min-h-screen">
            <ImpersonationBanner />
            {/* Sidebar */}
            <aside className="w-full md:w-72 glass border-r-0 md:border-r border-slate-800/60 p-8 flex flex-col items-center md:items-start shrink-0 z-20">
                <div className="mb-14 flex flex-col items-center md:items-start w-full">
                    <div className="flex items-end gap-3 transition-transform hover:scale-[1.02]">
                        <Link href="/" className="pb-0.5">
                            <Image
                                src="/images/logo-rioko-white.svg"
                                alt="Rioko Logo"
                                width={110}
                                height={28}
                                className="brightness-125"
                                priority
                            />
                        </Link>
                        <span className="text-sky-400 bg-sky-400/10 px-1.5 py-0.5 rounded text-[10px] font-black tracking-tighter border border-sky-400/20 mb-1.5 align-bottom">{RIOKO_CONFIG.version.split('.').slice(0, 2).join('.')}</span>
                    </div>

                    <div className="mt-4 flex flex-col items-start gap-1">
                        <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest opacity-60">Developed by</div>
                        <a href="https://kapta.pt" target="_blank" rel="noopener noreferrer" className="transition-all hover:scale-105 active:scale-95">
                            <Image src="/images/logo-kapta-white.webp" alt="Kapta Logo" width={70} height={18} className="opacity-40 grayscale hover:opacity-100 hover:grayscale-0 transition-all duration-500" />
                        </a>
                    </div>
                </div>

                <nav className="flex-1 w-full space-y-6">
                    <div className="space-y-1">
                        <span className="px-4 text-[10px] font-black text-slate-500 uppercase tracking-widest">Menu</span>
                        <div className="space-y-1 pt-2">
                            <Link
                                href="/dashboard"
                                className="flex items-center gap-3 px-4 py-3 rounded-2xl bg-sky-500/10 text-sky-400 border border-sky-500/20 font-bold text-sm transition-all hover:bg-sky-500/20"
                            >
                                <Activity className="w-4 h-4" />
                                Integrações
                            </Link>

                            {isSuperAdmin && (
                                <Link
                                    href="/superadmin"
                                    className="flex items-center gap-3 px-4 py-3 rounded-2xl text-slate-400 hover:text-white hover:bg-white/5 font-bold text-sm transition-all"
                                >
                                    <ShieldCheck className="w-4 h-4 text-rose-500" />
                                    Superadmin
                                </Link>
                            )}

                            <button disabled className="flex items-center gap-3 px-4 py-3 rounded-2xl text-slate-600 font-bold text-sm opacity-50 cursor-not-allowed w-full text-left">
                                <CreditCard className="w-4 h-4" />
                                Faturação (Brevemente)
                            </button>
                        </div>
                    </div>
                </nav>

                <div className="mt-auto space-y-4 w-full">
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
