"use client";

import { useState, useEffect } from "react";
import { Link, usePathname } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { Activity, ShieldCheck, Settings2, BookOpen, Zap, ScrollText, Receipt, Wrench } from "lucide-react";
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
    "bg-[rgba(2,141,196,0.18)] text-accent border-[rgba(2,141,196,0.45)] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]";
const ACTIVE_DANGER =
    "bg-[rgba(244,63,94,0.18)] text-destructive border-[rgba(244,63,94,0.45)] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]";
const INACTIVE = "text-fg-60 hover:text-fg hover:bg-white/5";

export function NavLinks({ canAccessAdmin, isHiperadmin }: { canAccessAdmin: boolean; isHiperadmin?: boolean }) {
    const t = useTranslations("nav");
    const rawPathname = usePathname() || "/";
    // Defensive: strip any leftover locale prefix and trailing slash so the
    // active matcher works regardless of which usePathname is in scope.
    const pathname = rawPathname.replace(/^\/(pt|en)(?=\/|$)/, "").replace(/\/$/, "") || "/";
    const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");

    const [activeIntegrations, setActiveIntegrations] = useState<ActiveIntegration[]>([]);
    const [isRegistered, setIsRegistered] = useState<boolean>(true);

    useEffect(() => {
        Promise.all([
            fetch("/api/integrations").then(r => r.json()).catch(() => ({})),
            fetch("/api/connections").then(r => r.json()).catch(() => ({ connections: [] })),
        ]).then(([intData, connData]: [any, any]) => {
            setIsRegistered(intData._registration_completed ?? true);
            const integrations: ActiveIntegration[] = [];

            // Legacy shopify-ix (integrations table)
            if (intData.shopify_domain && intData.ix_account_name) {
                integrations.push({ id: "shopify-ix", label: "Shopify + IX", href: "/integrations/shopify-ix", iconLetter: "S" });
            }

            // All active connections (connections table)
            const active = (connData.connections || []).filter((c: any) => c.status === "active");
            for (const conn of active) {
                const id = `${conn.source_kind}-${conn.destination_kind}`;
                if (integrations.find(i => i.id === id)) continue;
                const srcLabel = conn.source_kind === "lodgify" ? "Lodgify"
                    : conn.source_kind === "stripe" ? "Stripe"
                    : conn.source_kind === "shopify" ? "Shopify"
                    : conn.source_kind === "eupago" ? "EuPago"
                    : conn.source_kind;
                const destLabel = conn.destination_kind === "invoicexpress" ? "IX"
                    : conn.destination_kind === "moloni" ? "Moloni"
                    : conn.destination_kind === "vendus" ? "Vendus"
                    : conn.destination_kind;
                const dest = conn.destination_kind === "invoicexpress" ? "ix" : conn.destination_kind;
                integrations.push({
                    id,
                    label: `${srcLabel} + ${destLabel}`,
                    href: `/integrations/${conn.source_kind}-${dest}`,
                    iconLetter: srcLabel[0].toUpperCase(),
                });
            }

            setActiveIntegrations(integrations.slice(0, 3));
        });
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
                    className="px-4 py-3 rounded-2xl text-fg-40 cursor-not-allowed border border-transparent group relative"
                    title={tooltip}
                >
                    <div className="flex items-center gap-3 font-medium text-sm opacity-50">
                        <Icon className="w-4 h-4 text-fg-40" />
                        {label}
                    </div>
                    {tooltip && (
                        <div className="pl-7 mt-1 text-[10px] text-fg-40 leading-snug md:hidden">
                            {tooltip}
                        </div>
                    )}
                    {tooltip && (
                        <div className="hidden md:block absolute left-full ml-2 top-1/2 -translate-y-1/2 px-2 py-1 bg-surface-2 text-fg text-[10px] rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-50 pointer-events-none border border-hairline">
                            {tooltip}
                        </div>
                    )}
                </div>
            );
        }

        return (
            <Link
                href={href}
                className={cn(
                    "flex items-center gap-3 px-4 py-3 rounded-2xl font-medium text-sm transition-all border border-transparent",
                    isActive(href) ? activeClass : INACTIVE
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
                <span className="px-4 font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">{t("main")}</span>
                <div className="space-y-1">
                    <LinkItem href="/dashboard" icon={Activity} label={t("dashboard")} />
                    <LinkItem
                        href="/integrations"
                        icon={Zap}
                        label={t("integrations")}
                        disabled={!isRegistered}
                        tooltip={t("tooltipNeedRegister")}
                    />
                    <LinkItem
                        href="/conciliacao"
                        icon={ScrollText}
                        label={t("conciliacao")}
                        disabled={!isRegistered}
                        tooltip={t("tooltipNeedRegister")}
                    />
                    <LinkItem href="/faturacao" icon={Receipt} label={t("faturacao")} />
                    <LinkItem href="/help" icon={BookOpen} label={t("help")} />
                </div>
            </div>

            {/* Quick Links — Active Integrations */}
            {activeIntegrations.length > 0 && (
                <div className="space-y-2">
                    <span className="px-4 font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">{t("quick")}</span>
                    <div className="space-y-1">
                        {activeIntegrations.map((integration) => (
                            <Link
                                key={integration.id}
                                href={isRegistered ? integration.href : "#"}
                                onClick={!isRegistered ? (e) => e.preventDefault() : undefined}
                                className={cn(
                                    "flex items-center gap-3 px-4 py-3 rounded-2xl font-medium text-sm transition-all border border-transparent group relative",
                                    !isRegistered ? "opacity-30 cursor-not-allowed" : "",
                                    isActive(integration.href) ? ACTIVE_BRAND : INACTIVE
                                )}
                            >
                                <div className="w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-mono font-medium bg-surface-2 border border-hairline text-fg-60">
                                    {integration.iconLetter}
                                </div>
                                {integration.label}
                                {!isRegistered && (
                                    <div className="hidden md:block absolute left-full ml-2 top-1/2 -translate-y-1/2 px-2 py-1 bg-surface-2 text-fg text-[10px] rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-50 pointer-events-none border border-hairline">
                                        {t("tooltipNeedRegister")}
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
                    <span className="px-4 font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">{t("admin")}</span>
                    <div className="space-y-1">
                        {canAccessAdmin && (
                            <LinkItem
                                href="/superadmin"
                                icon={ShieldCheck}
                                label={t("superadmin")}
                                activeClass={ACTIVE_DANGER}
                            />
                        )}
                        {canAccessAdmin && (
                            <LinkItem
                                href="/onboarding-helper"
                                icon={Wrench}
                                label={t("onboardingHelper")}
                                activeClass={ACTIVE_DANGER}
                            />
                        )}
                        {isHiperadmin && (
                            <LinkItem
                                href="/client-rules"
                                icon={Settings2}
                                label={t("clientRules")}
                                activeClass={ACTIVE_DANGER}
                            />
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
