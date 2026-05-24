"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, ShieldCheck, Settings2, BookOpen, Zap, ScrollText, Receipt } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

interface ActiveIntegration {
    id: string;
    label: string;
    href: string;
    iconLetter: string;
}

const ACTIVE_BRAND =
    "bg-[rgba(2,141,196,0.10)] text-accent border-[rgba(2,141,196,0.25)]";
const ACTIVE_DANGER =
    "bg-[rgba(244,63,94,0.10)] text-destructive border-[rgba(244,63,94,0.25)]";
const INACTIVE = "text-fg-60 hover:text-fg hover:bg-white/5";

export function NavLinks({ canAccessAdmin, isHiperadmin }: { canAccessAdmin: boolean; isHiperadmin?: boolean }) {
    const pathname = usePathname();
    const [activeIntegrations, setActiveIntegrations] = useState<ActiveIntegration[]>([]);
    const [isRegistered, setIsRegistered] = useState<boolean>(true);

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
                        iconLetter: "S",
                    });
                }
                setActiveIntegrations(integrations.slice(0, 3));
            })
            .catch(() => { });
    }, []);

    const LinkItem = ({
        href,
        icon: Icon,
        label,
        activeClass = ACTIVE_BRAND,
        disabled,
        tooltip,
    }: {
        href: string;
        icon: React.ComponentType<{ className?: string }>;
        label: string;
        activeClass?: string;
        disabled?: boolean;
        tooltip?: string;
    }) => {
        if (disabled) {
            return (
                <div
                    className="flex items-center gap-3 px-4 py-3 rounded-2xl font-medium text-sm text-fg-40 opacity-50 cursor-not-allowed border border-transparent group relative"
                    title={tooltip}
                >
                    <Icon className="w-4 h-4 text-fg-40" />
                    {label}
                    <div className="absolute left-full ml-2 px-2 py-1 bg-surface-2 text-fg text-[10px] rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-50 pointer-events-none border border-hairline">
                        {tooltip}
                    </div>
                </div>
            );
        }

        return (
            <Link
                href={href}
                className={cn(
                    "flex items-center gap-3 px-4 py-3 rounded-2xl font-medium text-sm transition-all border border-transparent",
                    pathname === href ? activeClass : INACTIVE
                )}
            >
                <Icon className="w-4 h-4" />
                {label}
            </Link>
        );
    };

    return (
        <div className="flex-1 w-full flex flex-col gap-10">
            {/* Primary Menu */}
            <div className="space-y-2">
                <span className="px-4 font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">Menu Principal</span>
                <div className="space-y-1">
                    <LinkItem href="/dashboard" icon={Activity} label="Dashboard" />
                    <LinkItem
                        href="/integrations"
                        icon={Zap}
                        label="Integrações"
                        disabled={!isRegistered}
                        tooltip="Faça o registo no dashboard primeiro"
                    />
                    <LinkItem
                        href="/conciliacao"
                        icon={ScrollText}
                        label="Conciliação"
                        disabled={!isRegistered}
                        tooltip="Faça o registo no dashboard primeiro"
                    />
                    <LinkItem href="/faturacao" icon={Receipt} label="Faturação" />
                    <LinkItem href="/help" icon={BookOpen} label="Geral & Ajuda" />
                </div>
            </div>

            {/* Quick Links — Active Integrations */}
            {activeIntegrations.length > 0 && (
                <div className="space-y-2">
                    <span className="px-4 font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">Links Rápidos</span>
                    <div className="space-y-1">
                        {activeIntegrations.map((integration) => (
                            <Link
                                key={integration.id}
                                href={isRegistered ? integration.href : "#"}
                                onClick={!isRegistered ? (e) => e.preventDefault() : undefined}
                                className={cn(
                                    "flex items-center gap-3 px-4 py-3 rounded-2xl font-medium text-sm transition-all border border-transparent group relative",
                                    !isRegistered ? "opacity-30 cursor-not-allowed" : "",
                                    pathname.includes(integration.href) ? ACTIVE_BRAND : INACTIVE
                                )}
                            >
                                <div className="w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-mono font-medium bg-surface-2 border border-hairline text-fg-60">
                                    {integration.iconLetter}
                                </div>
                                {integration.label}
                                {!isRegistered && (
                                    <div className="absolute left-full ml-2 px-2 py-1 bg-surface-2 text-fg text-[10px] rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-50 pointer-events-none border border-hairline">
                                        Faça o registo no dashboard primeiro
                                    </div>
                                )}
                            </Link>
                        ))}
                    </div>
                </div>
            )}

            {/* Admin Section */}
            {(canAccessAdmin || isHiperadmin) && (
                <div className="space-y-2">
                    <span className="px-4 font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">Administração</span>
                    <div className="space-y-1">
                        {canAccessAdmin && (
                            <LinkItem
                                href="/superadmin"
                                icon={ShieldCheck}
                                label="Superadmin"
                                activeClass={ACTIVE_DANGER}
                            />
                        )}
                        {isHiperadmin && (
                            <LinkItem
                                href="/client-rules"
                                icon={Settings2}
                                label="Regras de Clientes"
                                activeClass={ACTIVE_DANGER}
                            />
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
