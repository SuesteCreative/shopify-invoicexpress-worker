"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { UserCog, LogOut, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

export function ImpersonationBanner() {
    const t = useTranslations("impersonationBanner");
    const [data, setData] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [acting, setActing] = useState(false);

    useEffect(() => {
        fetch("/api/admin/impersonation-status")
            .then(res => res.json())
            .then(d => setData(d))
            .catch(console.error)
            .finally(() => setLoading(false));
    }, []);

    const handleStop = async () => {
        setActing(true);
        try {
            const res = await fetch("/api/admin/impersonate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetId: null })
            });
            if (res.ok) {
                // Bare path, and a full navigation on purpose: the impersonation
                // cookie changes server-side, so a client-side route push would
                // keep rendering the old identity. /admin is not locale-prefixed.
                window.location.href = "/admin/clientes";
            }
        } catch (e) {
            console.error(e);
        } finally {
            setActing(false);
        }
    };

    if (loading || !data?.impersonating) return null;

    return (
        <AnimatePresence>
            <motion.div
                initial={{ y: -50 }}
                animate={{ y: 0 }}
                className="shrink-0 relative z-[100] bg-soon/95 border-b border-veil-strong py-2.5 px-6 shadow-2xl flex items-center justify-between"
            >
                <div className="flex items-center gap-4">
                    <div className="bg-white/20 p-2 rounded-xl ring-1 ring-white/30">
                        <UserCog className="w-4 h-4 text-on-accent" />
                    </div>
                    <div className="flex flex-col">
                        <div className="flex items-center gap-2">
                            <span className="font-mono text-[10px] text-on-accent/70 uppercase tracking-[0.22em] leading-none">{t("label")}</span>
                            <span className="text-sm font-medium text-on-accent leading-none">{data.user.name}</span>
                        </div>
                        <span className="text-[11px] font-medium text-on-accent/80">{data.user.email}</span>
                    </div>
                </div>

                <button
                    onClick={handleStop}
                    disabled={acting}
                    className="bg-white text-[#7C4A0F] px-5 py-2 rounded-xl font-mono text-[10px] uppercase tracking-[0.18em] hover:bg-surface hover:text-fg transition-all shadow-lg active:scale-95 flex items-center gap-2 disabled:opacity-50"
                >
                    {acting ? <Loader2 className="w-3 h-3 animate-spin" /> : <LogOut className="w-3 h-3" />}
                    {t("stop")}
                </button>
            </motion.div>
        </AnimatePresence>
    );
}
