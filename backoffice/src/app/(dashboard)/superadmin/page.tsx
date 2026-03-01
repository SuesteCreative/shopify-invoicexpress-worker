"use client";

export const runtime = "edge";

import { useState, useEffect } from "react";
import { ShieldCheck, User, Store, Activity, ArrowRight, UserCog, LogOut, Loader2, Check, X } from "lucide-react";
import { motion } from "framer-motion";

export default function SuperadminPage() {
    const [users, setUsers] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [acting, setActing] = useState<string | null>(null);

    useEffect(() => {
        fetchUsers();
    }, []);

    const fetchUsers = async () => {
        setLoading(true);
        try {
            const res = await fetch("/api/admin/users");
            const data = await res.json() as any[];
            setUsers(data);
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    const handleImpersonate = async (targetId: string | null) => {
        setActing(targetId || "clear");
        try {
            const res = await fetch("/api/admin/impersonate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetId })
            });
            if (res.ok) {
                window.location.href = "/dashboard";
            }
        } catch (err) {
            console.error(err);
        } finally {
            setActing(null);
        }
    };

    if (loading) {
        return (
            <div className="min-h-[60vh] flex items-center justify-center">
                <Loader2 className="w-12 h-12 text-rose-500 animate-spin opacity-50" />
            </div>
        );
    }

    return (
        <div className="space-y-12 animate-in fade-in duration-1000 slide-in-from-bottom-4">
            <div className="flex flex-col gap-2">
                <div className="flex items-center gap-3">
                    <ShieldCheck className="w-8 h-8 text-rose-500" />
                    <h1 className="text-5xl font-black tracking-tight bg-gradient-to-r from-white via-white to-slate-500 bg-clip-text text-transparent">
                        Superadmin
                    </h1>
                </div>
                <p className="text-slate-400 font-semibold tracking-wide">
                    Gestão central de contas e impersonação de utilizadores.
                </p>
            </div>

            <div className="grid gap-6">
                {users.map((user) => (
                    <motion.div
                        key={user.id}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="glass rounded-[2rem] p-8 border-slate-800/40 hover:border-slate-700/60 transition-all group"
                    >
                        <div className="flex flex-col lg:flex-row items-center gap-8">
                            {/* User Avatar / Info */}
                            <div className="w-16 h-16 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center shrink-0">
                                <User className="w-8 h-8 text-slate-600" />
                            </div>

                            <div className="flex-1 space-y-1 text-center lg:text-left">
                                <div className="flex items-center justify-center lg:justify-start gap-3">
                                    <h2 className="text-xl font-bold">{user.name}</h2>
                                    {user.role === "admin" && (
                                        <span className="px-2 py-0.5 rounded-md bg-rose-500/10 text-rose-500 text-[10px] font-black uppercase tracking-widest border border-rose-500/20">
                                            Admin
                                        </span>
                                    )}
                                </div>
                                <p className="text-slate-500 text-sm font-medium">{user.email}</p>
                            </div>

                            {/* Status Section */}
                            <div className="flex flex-wrap items-center justify-center gap-4 px-8 border-x-0 lg:border-x border-slate-800/40">
                                <div className="flex flex-col items-center gap-1">
                                    <span className="text-[10px] font-black text-slate-600 uppercase tracking-widest leading-none">Status</span>
                                    <div className="flex items-center gap-2">
                                        {user.is_connected ? (
                                            <div className="flex items-center gap-1.5 text-emerald-400 text-xs font-bold">
                                                <Check className="w-3 h-3" /> Ligado
                                            </div>
                                        ) : (
                                            <div className="flex items-center gap-1.5 text-slate-600 text-xs font-bold uppercase tracking-wider">
                                                <X className="w-3 h-3" /> Inativo
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <div className="flex flex-col items-center gap-1">
                                    <span className="text-[10px] font-black text-slate-600 uppercase tracking-widest leading-none">Domínio</span>
                                    <span className="text-xs font-bold text-slate-300">
                                        {user.shopify_domain || "---"}
                                    </span>
                                </div>
                            </div>

                            {/* Actions */}
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={() => handleImpersonate(user.id)}
                                    disabled={acting !== null}
                                    className="bg-white text-black px-6 py-3 rounded-2xl font-black text-[10px] uppercase tracking-widest flex items-center gap-2 hover:bg-rose-500 hover:text-white transition-all duration-500 active:scale-95 disabled:opacity-30"
                                >
                                    {acting === user.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserCog className="w-3 h-3" />}
                                    Impersonar
                                </button>
                            </div>
                        </div>
                    </motion.div>
                ))}
            </div>

            <div className="pt-10 flex justify-center">
                <button
                    onClick={() => handleImpersonate(null)}
                    className="flex items-center gap-2 text-slate-500 hover:text-white text-[10px] font-black uppercase tracking-[0.2em] transition-all py-4 px-8 border border-slate-800/40 rounded-2xl hover:bg-white/5"
                >
                    <LogOut className="w-4 h-4" />
                    Limpar Impersonação / Voltar ao Meu Perfil
                </button>
            </div>
        </div>
    );
}
