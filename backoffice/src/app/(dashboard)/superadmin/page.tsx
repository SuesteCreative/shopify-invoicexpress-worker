"use client";

export const runtime = "edge";

import { useState, useEffect, useMemo } from "react";
import { ShieldCheck, User, Store, Activity, ArrowRight, UserCog, LogOut, Loader2, Check, X, Search, Filter, ArrowUpDown, CalendarDays } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

export default function SuperadminPage() {
    const [users, setUsers] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [acting, setActing] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [sortOrder, setSortOrder] = useState<"desc" | "asc">("desc");

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

    const filteredAndSortedUsers = useMemo(() => {
        return users
            .filter((u) =>
                u.name?.toLowerCase().includes(search.toLowerCase()) ||
                u.email?.toLowerCase().includes(search.toLowerCase()) ||
                u.shopify_domain?.toLowerCase().includes(search.toLowerCase())
            )
            .sort((a, b) => {
                const dateA = new Date(a.created_at).getTime();
                const dateB = new Date(b.created_at).getTime();
                return sortOrder === "desc" ? dateB - dateA : dateA - dateB;
            });
    }, [users, search, sortOrder]);

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
            {/* Header & Controls */}
            <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-8">
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

                <div className="flex flex-wrap items-center gap-4">
                    <div className="relative group">
                        <Search className="w-4 h-4 text-slate-500 absolute left-4 top-1/2 -translate-y-1/2 group-focus-within:text-rose-500 transition-colors" />
                        <input
                            type="text"
                            placeholder="Pesquisar por nome ou email..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="bg-slate-900/50 border border-slate-800/60 rounded-2xl py-3 pl-12 pr-6 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500/40 w-full lg:w-80 transition-all shadow-inner"
                        />
                    </div>

                    <button
                        onClick={() => setSortOrder(prev => prev === "desc" ? "asc" : "desc")}
                        className="bg-slate-900/50 border border-slate-800/60 rounded-2xl px-5 py-3 text-xs font-black uppercase tracking-widest flex items-center gap-3 hover:bg-slate-800/80 transition-all active:scale-95"
                    >
                        <ArrowUpDown className="w-4 h-4 text-rose-500" />
                        {sortOrder === "desc" ? "Mais Recentes" : "Mais Antigos"}
                    </button>
                </div>
            </div>

            {/* Stats Counter */}
            <div className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-600 border-b border-slate-800/40 pb-4 flex justify-between">
                <span>A mostrar {filteredAndSortedUsers.length} de {users.length} utilizadores</span>
                <span>Rioko 2.0 Database</span>
            </div>

            <div className="grid gap-6">
                <AnimatePresence mode="popLayout">
                    {filteredAndSortedUsers.map((user) => (
                        <motion.div
                            layout
                            key={user.id}
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.95 }}
                            className="glass rounded-[2rem] p-8 border-slate-800/40 hover:border-slate-700/60 transition-all group"
                        >
                            <div className="flex flex-col lg:flex-row items-center gap-8">
                                {/* User Avatar / Info */}
                                <div className="w-16 h-16 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center shrink-0">
                                    <User className="w-8 h-8 text-slate-600" />
                                </div>

                                <div className="flex-1 space-y-2 text-center lg:text-left">
                                    <div className="flex items-center justify-center lg:justify-start gap-3">
                                        <h2 className="text-xl font-bold">{user.name}</h2>
                                        {user.role === "admin" && (
                                            <span className="px-2 py-0.5 rounded-md bg-rose-500/10 text-rose-500 text-[10px] font-black uppercase tracking-widest border border-rose-500/20">
                                                Admin
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex flex-col gap-1.5">
                                        <p className="text-slate-500 text-sm font-medium">{user.email}</p>
                                        <div className="flex items-center justify-center lg:justify-start gap-2 text-[10px] font-black text-slate-600 uppercase tracking-widest">
                                            <CalendarDays className="w-3 h-3 text-rose-500/60" />
                                            Adesão: {new Date(user.created_at).toLocaleDateString('pt-PT')}
                                        </div>
                                    </div>
                                </div>

                                {/* Status Section */}
                                <div className="flex flex-wrap items-center justify-center gap-6 px-10 border-x-0 lg:border-x border-slate-800/40">
                                    <div className="flex flex-col items-center gap-1.5">
                                        <span className="text-[10px] font-black text-slate-700 uppercase tracking-widest leading-none">Status</span>
                                        <div className="flex items-center gap-4">
                                            <div className="flex flex-col items-center">
                                                <span className="text-[8px] font-black text-slate-600 uppercase mb-1 opacity-50">Shopify</span>
                                                {user.shopify_authorized ? (
                                                    <div className="text-emerald-400 text-[10px] font-bold">● OK</div>
                                                ) : (
                                                    <div className="text-amber-500 text-[10px] font-bold text-center">
                                                        {user.shopify_domain ? "● ERR" : "● OFF"}
                                                    </div>
                                                )}
                                            </div>
                                            <div className="flex flex-col items-center">
                                                <span className="text-[8px] font-black text-slate-600 uppercase mb-1 opacity-50">IX API</span>
                                                {user.ix_authorized ? (
                                                    <div className="text-emerald-400 text-[10px] font-bold">● OK</div>
                                                ) : (
                                                    <div className="text-amber-500 text-[10px] font-bold text-center">
                                                        ● ERR
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    <div className="flex flex-col items-center gap-1.5">
                                        <span className="text-[10px] font-black text-slate-700 uppercase tracking-widest leading-none">Domínio Loja</span>
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
                </AnimatePresence>
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
