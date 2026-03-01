"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, ShieldCheck, CreditCard, Settings2, BookOpen } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export function NavLinks({ isSuperAdmin, isHiperadmin }: { isSuperAdmin: boolean; isHiperadmin?: boolean }) {
    const pathname = usePathname();

    return (
        <nav className="flex-1 w-full space-y-6">
            <div className="space-y-1">
                <span className="px-4 text-[10px] font-black text-slate-500 uppercase tracking-widest">Menu</span>
                <div className="space-y-1 pt-2">
                    <Link
                        href="/dashboard"
                        className={cn(
                            "flex items-center gap-3 px-4 py-3 rounded-2xl font-bold text-sm transition-all",
                            pathname === "/dashboard"
                                ? "bg-sky-500/10 text-sky-400 border border-sky-500/20 shadow-[0_0_20px_rgba(56,189,248,0.1)]"
                                : "text-slate-400 hover:text-white hover:bg-white/5 border border-transparent"
                        )}
                    >
                        <Activity className="w-4 h-4" />
                        Integrações
                    </Link>

                    {isSuperAdmin && (
                        <Link
                            href="/superadmin"
                            className={cn(
                                "flex items-center gap-3 px-4 py-3 rounded-2xl font-bold text-sm transition-all",
                                pathname === "/superadmin"
                                    ? "bg-rose-500/10 text-rose-400 border border-rose-500/20 shadow-[0_0_20px_rgba(244,63,94,0.1)]"
                                    : "text-slate-400 hover:text-white hover:bg-white/5 border border-transparent"
                            )}
                        >
                            <ShieldCheck className="w-4 h-4 text-rose-500" />
                            Superadmin
                        </Link>
                    )}

                    {isHiperadmin && (
                        <Link
                            href="/client-rules"
                            className={cn(
                                "flex items-center gap-3 px-4 py-3 rounded-2xl font-bold text-sm transition-all",
                                pathname === "/client-rules"
                                    ? "bg-violet-500/10 text-violet-400 border border-violet-500/20 shadow-[0_0_20px_rgba(139,92,246,0.1)]"
                                    : "text-slate-400 hover:text-white hover:bg-white/5 border border-transparent"
                            )}
                        >
                            <Settings2 className="w-4 h-4 text-violet-500" />
                            Regras de Clientes
                        </Link>
                    )}

                    <Link
                        href="/help"
                        className={cn(
                            "flex items-center gap-3 px-4 py-3 rounded-2xl font-bold text-sm transition-all",
                            pathname === "/help"
                                ? "bg-amber-500/10 text-amber-400 border border-amber-500/20 shadow-[0_0_20px_rgba(245,158,11,0.1)]"
                                : "text-slate-400 hover:text-white hover:bg-white/5 border border-transparent"
                        )}
                    >
                        <BookOpen className="w-4 h-4" />
                        Ajuda
                    </Link>

                    <button disabled className="flex items-center gap-3 px-4 py-3 rounded-2xl text-slate-600 font-bold text-sm opacity-30 cursor-not-allowed w-full text-left">
                        <CreditCard className="w-4 h-4" />
                        Faturação (Brevemente)
                    </button>
                </div>
            </div>
        </nav>
    );
}
