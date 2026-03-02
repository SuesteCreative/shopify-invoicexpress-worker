"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, ShieldCheck, ClipboardList, Settings2, BookOpen, Zap, Store } from "lucide-react";
import Image from "next/image";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

interface ActiveIntegration {
    id: string;
    label: string;
    href: string;
    colorClass: string;
    activeClass: string;
    iconLetter: string;
    iconBg: string;
}

export function NavLinks({ canAccessAdmin, isHiperadmin }: { canAccessAdmin: boolean; isHiperadmin?: boolean }) {
    const pathname = usePathname();
    const [activeIntegrations, setActiveIntegrations] = useState<ActiveIntegration[]>([]);
    const [isRegistered, setIsRegistered] = useState<boolean>(true); // Default to true to prevent flickering

    useEffect(() => {
        fetch("/api/integrations")
            .then(res => res.json())
            .then((data: any) => {
                setIsRegistered(data._registration_completed);
                const integrations: ActiveIntegration[] = [];
                if (data.shopify_domain && data.ix_account_name) {
                    integrations.push({
                        id: "shopify-ix",
                        label: "Shopify + IX",
                        href: "/integrations/shopify-ix",
                        colorClass: "text-violet-400",
                        activeClass: "bg-violet-500/10 text-violet-400 border-violet-500/20 shadow-[0_0_20px_rgba(139,92,246,0.1)]",
                        iconLetter: "S",
                        iconBg: "bg-violet-500/20 text-violet-400",
                    });
                }
                // Future integrations would be added here
                setActiveIntegrations(integrations.slice(0, 3));
            })
            .catch(() => { });
    }, []);

    const LinkItem = ({ href, icon: Icon, label, colorClass, activeClass, disabled, tooltip }: any) => {
        if (disabled) {
            return (
                <div
                    className="flex items-center gap-3 px-4 py-3 rounded-2xl font-bold text-sm text-slate-600 opacity-50 cursor-not-allowed border border-transparent group relative"
                    title={tooltip}
                >
                    <Icon className={cn("w-4 h-4 text-slate-600")} />
                    {label}
                    <div className="absolute left-full ml-2 px-2 py-1 bg-slate-800 text-white text-[10px] rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-50 pointer-events-none">
                        {tooltip}
                    </div>
                </div>
            );
        }

        return (
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
    };

    return (
        <div className="flex-1 w-full flex flex-col gap-10">
            {/* Primary Menu */}
            <div className="space-y-2">
                <span className="px-4 text-[10px] font-black text-slate-500 uppercase tracking-widest">Menu Principal</span>
                <div className="space-y-1">
                    <LinkItem
                        href="/dashboard"
                        icon={Activity}
                        label="Dashboard"
                        colorClass="text-emerald-400"
                        activeClass="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 shadow-[0_0_20px_rgba(16,185,129,0.1)]"
                    />
                    <LinkItem
                        href="/integrations"
                        icon={Zap}
                        label="Integrações"
                        colorClass="text-sky-400"
                        activeClass="bg-sky-500/10 text-sky-400 border-sky-500/20 shadow-[0_0_20px_rgba(56,189,248,0.1)]"
                        disabled={!isRegistered}
                        tooltip="Faça o registo no dashboard primeiro"
                    />

                    <LinkItem
                        href="/invoices"
                        icon={ClipboardList}
                        label="Faturas"
                        colorClass="text-indigo-400"
                        activeClass="bg-indigo-500/10 text-indigo-400 border-indigo-500/20 shadow-[0_0_20px_rgba(129,140,248,0.1)]"
                        disabled={!isRegistered}
                        tooltip="Faça o registo no dashboard primeiro"
                    />
                    <LinkItem
                        href="/help"
                        icon={BookOpen}
                        label="Geral & Ajuda"
                        colorClass="text-amber-400"
                        activeClass="bg-amber-500/10 text-amber-400 border-amber-500/20 shadow-[0_0_20px_rgba(245,158,11,0.1)]"
                    />
                </div>
            </div>

            {/* Quick Links - Active Integrations (hidden if none) */}
            {activeIntegrations.length > 0 && (
                <div className="space-y-2">
                    <span className="px-4 text-[10px] font-black text-slate-500 uppercase tracking-widest">Links Rápidos</span>
                    <div className="space-y-1">
                        {activeIntegrations.map((integration) => (
                            <Link
                                key={integration.id}
                                href={isRegistered ? integration.href : "#"}
                                onClick={!isRegistered ? (e) => e.preventDefault() : undefined}
                                className={cn(
                                    "flex items-center gap-3 px-4 py-3 rounded-2xl font-bold text-sm transition-all border border-transparent group relative",
                                    !isRegistered ? "opacity-30 cursor-not-allowed" : "",
                                    pathname.includes(integration.href)
                                        ? integration.activeClass
                                        : "text-slate-500 hover:text-white hover:bg-white/5 opacity-60 hover:opacity-100"
                                )}
                            >
                                <div className={cn("w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-black", integration.iconBg)}>
                                    {integration.iconLetter}
                                </div>
                                {integration.label}
                                {!isRegistered && (
                                    <div className="absolute left-full ml-2 px-2 py-1 bg-slate-800 text-white text-[10px] rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-50 pointer-events-none">
                                        Faça o registo no dashboard primeiro
                                    </div>
                                )}
                            </Link>
                        ))}
                    </div>
                </div>
            )}

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
