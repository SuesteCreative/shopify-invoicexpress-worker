"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, ShieldCheck, ClipboardList, Settings2, BookOpen } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export function NavLinks({ canAccessAdmin, isHiperadmin }: { canAccessAdmin: boolean; isHiperadmin?: boolean }) {
    const pathname = usePathname();

    const LinkItem = ({ href, icon: Icon, label, colorClass, activeClass }: any) => (
        <Link
            href={href}
            className={cn(
                "flex items-center gap-3 px-4 py-3 rounded-2xl font-bold text-sm transition-all border border-transparent",
                pathname === href
                    ? activeClass
                    : "text-slate-400 hover:text-white hover:bg-white/5"
            )}
        >
            <Icon className={cn("w-4 h-4", colorClass)} />
            {label}
        </Link>
    );

    return (
        <div className="flex-1 w-full flex flex-col gap-10">
            {/* Primary Menu */}
            <div className="space-y-2">
                <span className="px-4 text-[10px] font-black text-slate-500 uppercase tracking-widest">Menu Principal</span>
                <div className="space-y-1">
                    <LinkItem
                        href="/dashboard"
                        icon={Activity}
                        label="Integrações"
                        colorClass="text-sky-400"
                        activeClass="bg-sky-500/10 text-sky-400 border-sky-500/20 shadow-[0_0_20px_rgba(56,189,248,0.1)]"
                    />
                    <button disabled className="flex items-center gap-3 px-4 py-3 rounded-2xl text-slate-600 font-bold text-sm opacity-30 cursor-not-allowed w-full text-left">
                        <ClipboardList className="w-4 h-4" />
                        Faturas (Breve)
                    </button>
                    <LinkItem
                        href="/help"
                        icon={BookOpen}
                        label="Geral & Ajuda"
                        colorClass="text-amber-400"
                        activeClass="bg-amber-500/10 text-amber-400 border-amber-500/20 shadow-[0_0_20px_rgba(245,158,11,0.1)]"
                    />
                </div>
            </div>

            {/* Admin Section (Grouped above logout) */}
            {(canAccessAdmin || isHiperadmin) && (
                <div className="space-y-2">
                    <span className="px-4 text-[10px] font-black text-slate-500 uppercase tracking-widest focus:text-violet-400">Administração</span>
                    <div className="space-y-1">
                        {canAccessAdmin && (
                            <LinkItem
                                href="/superadmin"
                                icon={ShieldCheck}
                                label="Superadmin"
                                colorClass="text-rose-500"
                                activeClass="bg-rose-500/10 text-rose-400 border-rose-500/20 shadow-[0_0_20px_rgba(244,63,94,0.1)]"
                            />
                        )}
                        {isHiperadmin && (
                            <LinkItem
                                href="/client-rules"
                                icon={Settings2}
                                label="Regras de Clientes"
                                colorClass="text-violet-500"
                                activeClass="bg-violet-500/10 text-violet-400 border-violet-500/20 shadow-[0_0_20px_rgba(139,92,246,0.1)]"
                            />
                        )}
                    </div>
                </div>
            )}

        </div>
    );
}
