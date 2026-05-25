"use client";

import { useState, useEffect } from "react";
import { UserButton, SignOutButton } from "@clerk/nextjs";
import Image from "next/image";
import { Link, usePathname } from "@/i18n/navigation";
import { LogOut, Menu, X } from "lucide-react";
import { NavLinks } from "@/components/NavLinks";
import { LangToggle } from "@/components/landing/LangToggle";

type SidebarStrings = {
    developedBy: string;
    account: string;
    connected: string;
    signOut: string;
    rights: string;
    stableBuild: string;
    previewBuild: string;
    openMenu: string;
    closeMenu: string;
};

export function Sidebar({
    canAccessAdmin,
    isHiperadmin,
    version,
    isStable,
    strings,
}: {
    canAccessAdmin: boolean;
    isHiperadmin: boolean;
    version: string;
    isStable: boolean;
    strings: SidebarStrings;
}) {
    const [open, setOpen] = useState(false);
    const pathname = usePathname();

    // Close drawer on navigation
    useEffect(() => {
        setOpen(false);
    }, [pathname]);

    // Lock body scroll when drawer open on mobile
    useEffect(() => {
        if (open) {
            const prev = document.body.style.overflow;
            document.body.style.overflow = "hidden";
            return () => {
                document.body.style.overflow = prev;
            };
        }
    }, [open]);

    const buildBadge = isStable ? strings.stableBuild : strings.previewBuild;

    return (
        <>
            {/* Mobile top bar — only visible <md */}
            <div className="md:hidden sticky top-0 z-30 glass border-b border-hairline flex items-center justify-between px-4 py-3 shrink-0">
                <Link href="/" className="flex items-center">
                    <Image src="/images/rioko2-logo.svg" alt="Rioko 2.0" width={104} height={22} priority />
                </Link>
                <button
                    type="button"
                    onClick={() => setOpen(true)}
                    aria-label={strings.openMenu}
                    className="p-2 rounded-xl border border-hairline hover:bg-surface-2 transition-colors"
                >
                    <Menu className="w-5 h-5 text-fg" />
                </button>
            </div>

            {/* Backdrop for mobile drawer */}
            {open && (
                <div
                    role="presentation"
                    onClick={() => setOpen(false)}
                    className="md:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
                />
            )}

            {/* Sidebar — drawer on mobile (slides in from left), static on md+ */}
            <aside
                className={`
                    glass border-r border-hairline p-8 flex flex-col items-start shrink-0 overflow-y-auto scrollbar-hide
                    fixed inset-y-0 left-0 z-50 w-[280px] max-w-[85vw] transform transition-transform
                    md:static md:transform-none md:transition-none md:w-72 md:max-w-none md:z-20 md:sticky md:top-0 md:h-screen
                    ${open ? "translate-x-0" : "-translate-x-full"} md:translate-x-0
                `}
            >
                {/* Close button — mobile only */}
                <div className="md:hidden self-end -mt-2 -mr-2 mb-4">
                    <button
                        type="button"
                        onClick={() => setOpen(false)}
                        aria-label={strings.closeMenu}
                        className="p-2 rounded-xl hover:bg-surface-2 transition-colors"
                    >
                        <X className="w-5 h-5 text-fg" />
                    </button>
                </div>

                <div className="mb-14 flex flex-col items-start w-full">
                    <div className="flex items-center transition-transform hover:scale-[1.02]">
                        <Link href="/">
                            <Image src="/images/rioko2-logo.svg" alt="Rioko 2.0" width={140} height={29} priority />
                        </Link>
                    </div>

                    <div className="mt-4 flex flex-col items-start gap-1">
                        <div className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">{strings.developedBy}</div>
                        <a href="https://kapta.pt" target="_blank" rel="noopener noreferrer" className="transition-all hover:scale-105 active:scale-95">
                            <Image src="/images/logo-kapta-white.webp" alt="Kapta Logo" width={70} height={18} className="opacity-40 grayscale hover:opacity-100 hover:grayscale-0 transition-all duration-500" />
                        </a>
                    </div>
                </div>

                <NavLinks canAccessAdmin={canAccessAdmin} isHiperadmin={isHiperadmin} />

                <div className="mt-auto space-y-4 w-full pt-8">
                    <div className="flex items-center justify-center">
                        <LangToggle variant="dark" />
                    </div>

                    <div className="px-4 py-3 rounded-2xl bg-surface-2 border border-hairline flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <UserButton afterSignOutUrl="/" />
                            <div className="flex flex-col">
                                <span className="font-mono text-[10px] text-fg uppercase tracking-[0.18em]">{strings.account}</span>
                                <span className="font-mono text-[9px] text-fg-40 uppercase truncate max-w-[140px] md:max-w-[100px]">{strings.connected}</span>
                            </div>
                        </div>
                        <SignOutButton>
                            <button
                                className="p-2 rounded-lg text-fg-40 transition-all cursor-pointer hover:bg-[rgba(244,63,94,0.10)] hover:text-destructive"
                                aria-label={strings.signOut}
                            >
                                <LogOut className="w-4 h-4" />
                            </button>
                        </SignOutButton>
                    </div>

                    <div className="pt-6 border-t border-hairline w-full text-left space-y-1">
                        <div className="font-mono text-[10px] text-fg-40 leading-snug tracking-[0.14em]">
                            © {new Date().getFullYear()}{" "}
                            <a href="https://kapta.pt/" target="_blank" rel="noopener noreferrer" className="text-fg-60 hover:text-accent transition-colors">
                                Kapta
                            </a>
                            .
                        </div>
                        <div className="font-mono text-[10px] text-fg-40 leading-snug tracking-[0.06em]">
                            {strings.rights}
                        </div>
                        <div className="pt-1 font-mono text-[9px] text-fg-40 tracking-[0.22em] uppercase">v{version} {buildBadge}</div>
                    </div>
                </div>
            </aside>
        </>
    );
}
