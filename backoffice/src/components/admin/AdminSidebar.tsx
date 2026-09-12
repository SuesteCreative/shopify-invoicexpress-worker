"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import { LayoutDashboard, ShieldCheck, Zap, Wallet, Activity, Wrench, Settings2, ScrollText, ArrowLeft, Menu, X } from "lucide-react";
import { ThemedLogo } from "@/components/ThemedLogo";
import { ThemeToggle } from "@/components/ThemeToggle";

/**
 * Navigation for the admin surface.
 *
 * `next/link` and `next/navigation`, never `@/i18n/navigation`: these hrefs must
 * stay bare. The i18n Link would emit /pt/admin, and /pt/admin is a 404 — the
 * middleware bypass covers /admin only.
 *
 * Labels are hardcoded Portuguese, like OnboardingHelperPanel already is. The
 * surface is internal; a nav.admin* namespace would be two files to keep in
 * sync for readers who do not exist.
 *
 * Not a variant of components/Sidebar.tsx: that one is merchant-shaped — it
 * fetches /api/integrations and /api/connections to list a merchant's own
 * pipes, carries the build badge and the registration tooltip. Adapting it
 * costs more than the fifty lines below.
 */

const ACTIVE = "bg-destructive/18 text-destructive border-destructive/45 shadow-[inset_0_1px_0_var(--glass-inset)]";
const INACTIVE = "text-fg-60 hover:text-fg hover:bg-fg/5";

type Item = { href: string; icon: React.ComponentType<{ className?: string }>; label: string };

const ITEMS: Item[] = [
    { href: "/admin", icon: LayoutDashboard, label: "Visão geral" },
    { href: "/admin/clientes", icon: ShieldCheck, label: "Clientes" },
    { href: "/admin/integracoes", icon: Zap, label: "Integrações" },
    { href: "/admin/financeiro", icon: Wallet, label: "Financeiro" },
    { href: "/admin/ops", icon: Activity, label: "Operação" },
    { href: "/admin/onboarding-helper", icon: Wrench, label: "Onboarding" },
    { href: "/admin/changelog", icon: ScrollText, label: "Notas de versão" },
];

const HIPERADMIN_ITEMS: Item[] = [
    { href: "/admin/client-rules", icon: Settings2, label: "Regras fiscais" },
];

export function AdminSidebar({ isHiperadmin }: { isHiperadmin: boolean }) {
    const [open, setOpen] = useState(false);
    const pathname = usePathname() || "/admin";

    useEffect(() => { setOpen(false); }, [pathname]);

    // /admin is exact-matched, or it lights up on every child route.
    const isActive = (href: string) =>
        href === "/admin" ? pathname === "/admin" : pathname === href || pathname.startsWith(href + "/");

    const items = isHiperadmin ? [...ITEMS, ...HIPERADMIN_ITEMS] : ITEMS;

    return (
        <>
            {/* Mobile top bar */}
            <div className="md:hidden sticky top-0 z-30 glass border-b border-hairline flex items-center justify-between px-4 py-3 shrink-0">
                <Link href="/admin" className="flex items-center">
                    <ThemedLogo nightSrc="/images/rioko2-logo.svg" daySrc="/images/rioko2-logo-light2.svg" alt="Rioko Admin" width={104} height={22} priority />
                </Link>
                <button
                    type="button"
                    onClick={() => setOpen(true)}
                    aria-label="Abrir menu"
                    className="p-2 rounded-xl border border-hairline hover:bg-surface-2 transition-colors"
                >
                    <Menu className="w-5 h-5 text-fg" />
                </button>
            </div>

            {open && (
                <div
                    role="presentation"
                    onClick={() => setOpen(false)}
                    className="md:hidden fixed inset-0 z-40 bg-scrim backdrop-blur-sm"
                />
            )}

            <aside
                className={`
                    glass border-r border-hairline p-8 flex flex-col items-start shrink-0 overflow-y-auto scrollbar-hide
                    fixed inset-y-0 left-0 z-50 w-[280px] max-w-[85vw] transform transition-transform
                    md:static md:transform-none md:transition-none md:w-72 md:max-w-none md:z-20 md:sticky md:top-0 md:h-full
                    ${open ? "translate-x-0" : "-translate-x-full"} md:translate-x-0
                `}
            >
                <div className="md:hidden self-end -mt-2 -mr-2 mb-4">
                    <button
                        type="button"
                        onClick={() => setOpen(false)}
                        aria-label="Fechar menu"
                        className="p-2 rounded-xl hover:bg-surface-2 transition-colors"
                    >
                        <X className="w-5 h-5 text-fg" />
                    </button>
                </div>

                <div className="mb-14 flex flex-col items-start w-full">
                    <Link href="/admin" className="flex items-center transition-transform hover:scale-[1.02]">
                        <ThemedLogo nightSrc="/images/rioko2-logo.svg" daySrc="/images/rioko2-logo-light2.svg" alt="Rioko Admin" width={140} height={29} priority />
                    </Link>
                    <div className="mt-3 font-mono text-[10px] text-destructive uppercase tracking-[0.22em]">
                        Administração
                    </div>
                </div>

                <nav className="flex-1 w-full space-y-1">
                    {items.map(({ href, icon: Icon, label }) => (
                        <Link
                            key={href}
                            href={href}
                            className={`flex items-center gap-3 px-4 py-3 rounded-2xl font-medium text-sm transition-all border border-transparent ${isActive(href) ? ACTIVE : INACTIVE}`}
                        >
                            <Icon className="w-4 h-4" />
                            {label}
                        </Link>
                    ))}
                </nav>

                <div className="mt-auto space-y-4 w-full pt-8">
                    {/* The way back to the merchant app. Locale-prefixed on
                        purpose: that surface does live under [locale]. */}
                    <Link
                        href="/pt/dashboard"
                        className="flex items-center gap-3 px-4 py-3 rounded-2xl font-medium text-sm text-fg-60 hover:text-fg hover:bg-fg/5 transition-all"
                    >
                        <ArrowLeft className="w-4 h-4" />
                        Voltar ao Rioko
                    </Link>

                    <div className="flex justify-center">
                        <ThemeToggle />
                    </div>

                    <div className="px-4 py-3 rounded-2xl bg-surface-2 border border-hairline flex items-center gap-3">
                        <UserButton afterSignOutUrl="/" />
                        <div className="flex flex-col">
                            <span className="font-mono text-[10px] text-fg uppercase tracking-[0.18em]">
                                {isHiperadmin ? "Hiperadmin" : "Superadmin"}
                            </span>
                        </div>
                    </div>
                </div>
            </aside>
        </>
    );
}
