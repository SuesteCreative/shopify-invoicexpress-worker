"use client";

import { useEffect, useState } from "react";
import { UserCog, LogOut, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

export function ImpersonationBanner() {
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
                window.location.reload();
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
                className="fixed top-0 left-0 right-0 z-[100] bg-gradient-to-r from-amber-600 via-amber-500 to-amber-600 border-b border-white/10 py-2.5 px-6 shadow-2xl flex items-center justify-between"
            >
                <div className="flex items-center gap-4">
                    <div className="bg-white/20 p-2 rounded-xl ring-1 ring-white/30">
                        <UserCog className="w-4 h-4 text-white" />
                    </div>
                    <div className="flex flex-col">
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] font-black text-white/60 uppercase tracking-widest leading-none">A Impersonar Utilizador:</span>
                            <span className="text-sm font-black text-white leading-none">{data.user.name}</span>
                        </div>
                        <span className="text-[11px] font-bold text-white/80">{data.user.email}</span>
                    </div>
                </div>

                <button
                    onClick={handleStop}
                    disabled={acting}
                    className="bg-white text-amber-600 px-5 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-black hover:text-white transition-all shadow-lg active:scale-95 flex items-center gap-2 disabled:opacity-50"
                >
                    {acting ? <Loader2 className="w-3 h-3 animate-spin" /> : <LogOut className="w-3 h-3" />}
                    Sair da Impersonação
                </button>
            </motion.div>
        </AnimatePresence>
    );
}
