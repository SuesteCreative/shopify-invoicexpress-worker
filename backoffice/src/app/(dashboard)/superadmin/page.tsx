"use client";

export const runtime = "edge";

import { useState, useEffect, useMemo } from "react";
import { ShieldCheck, User, Store, Activity, ArrowRight, UserCog, LogOut, Loader2, Check, X, Search, ArrowUpDown, CalendarDays, HelpCircle, Trash2, ShieldPlus, ShieldOff } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useUser } from "@clerk/nextjs";

export default function SuperadminPage() {
    const { user: clerkUser } = useUser();
    const [users, setUsers] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [acting, setActing] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [sortOrder, setSortOrder] = useState<"desc" | "asc">("desc");
    const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null); // userId pending delete
    const [callerRole, setCallerRole] = useState<string>("user");

    useEffect(() => { fetchUsers(); }, []);

    const fetchUsers = async () => {
        setLoading(true);
        try {
            const res = await fetch("/api/admin/users");
            const data = await res.json() as any[];
            setUsers(data);
            // Detect caller's role from the data (own entry)
            const self = data.find((u: any) => u.id === clerkUser?.id);
            if (self) setCallerRole(self.role);
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
            if (res.ok) window.location.href = "/dashboard";
        } catch (err) {
            console.error(err);
        } finally {
            setActing(null);
        }
    };

    const handleRoleChange = async (targetId: string, newRole: "admin" | "user") => {
        setActing(targetId);
        try {
            await fetch("/api/admin/users", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetId, role: newRole })
            });
            await fetchUsers();
        } catch (err) {
            console.error(err);
        } finally {
            setActing(null);
        }
    };

    const handleDelete = async (targetId: string) => {
        setActing(targetId);
        setDeleteConfirm(null);
        try {
            const res = await fetch("/api/admin/users", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetId })
            });
            if (res.ok) {
                setUsers(prev => prev.filter(u => u.id !== targetId));
            } else {
                const err = await res.json() as any;
                alert(`Erro: ${err.error}`);
            }
        } catch (err) {
            console.error(err);
        } finally {
            setActing(null);
        }
    };

    const isSuperAdmin = callerRole === "superadmin";

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
                <span>Rioko 2.0 Database · {isSuperAdmin ? "Superadmin" : "Admin"}</span>
            </div>

            <div className="grid gap-6">
                <AnimatePresence mode="popLayout">
                    {filteredAndSortedUsers.map((user) => {
                        const isSelf = clerkUser?.id === user.id;
                        const isUserSuperAdmin = user.role === "superadmin";
                        const isUserAdmin = user.role === "admin";
                        const canImpersonate = !isSelf;
                        const canPromote = isSuperAdmin && !isSelf && !isUserSuperAdmin;
                        const canDelete = !isSelf && !isUserSuperAdmin && (isSuperAdmin || !isUserAdmin);

                        return (
                            <motion.div
                                layout
                                key={user.id}
                                initial={{ opacity: 0, scale: 0.95 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.95, height: 0 }}
                                className="glass rounded-[2rem] p-8 border-slate-800/40 hover:border-slate-700/60 transition-all group"
                            >
                                <div className="flex flex-col lg:flex-row items-center gap-8">
                                    {/* Avatar */}
                                    <div className="w-16 h-16 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center shrink-0">
                                        {isUserSuperAdmin
                                            ? <ShieldCheck className="w-8 h-8 text-rose-500" />
                                            : isUserAdmin
                                                ? <ShieldPlus className="w-8 h-8 text-amber-500" />
                                                : <User className="w-8 h-8 text-slate-600" />
                                        }
                                    </div>

                                    {/* Info */}
                                    <div className="flex-1 space-y-2 text-center lg:text-left">
                                        <div className="flex items-center justify-center lg:justify-start gap-3 flex-wrap">
                                            <h2 className="text-xl font-bold">{user.name}</h2>
                                            {isUserSuperAdmin && (
                                                <span className="px-2 py-0.5 rounded-md bg-rose-500/10 text-rose-500 text-[10px] font-black uppercase tracking-widest border border-rose-500/20">
                                                    Superadmin
                                                </span>
                                            )}
                                            {isUserAdmin && (
                                                <span className="px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-400 text-[10px] font-black uppercase tracking-widest border border-amber-500/20">
                                                    Admin
                                                </span>
                                            )}
                                            {isSelf && (
                                                <span className="px-2 py-0.5 rounded-md bg-slate-800 text-slate-500 text-[10px] font-black uppercase tracking-widest border border-slate-700/40">
                                                    A Sua Conta
                                                </span>
                                            )}
                                        </div>
                                        <div className="flex flex-col gap-1.5">
                                            <p className="text-slate-500 text-sm font-medium">{user.email}</p>
                                            <div className="flex items-center justify-center lg:justify-start gap-2 text-[10px] font-black text-slate-600 uppercase tracking-widest">
                                                <CalendarDays className="w-3 h-3 text-rose-500/60" />
                                                Adesão: {new Date(user.created_at).toLocaleDateString("pt-PT")}
                                            </div>
                                        </div>
                                    </div>

                                    {/* Status */}
                                    <div className="flex flex-wrap items-center justify-center gap-6 px-10 border-x-0 lg:border-x border-slate-800/40">
                                        <div className="flex flex-col items-center gap-1.5">
                                            <span className="text-[10px] font-black text-slate-700 uppercase tracking-widest leading-none">Status</span>
                                            <div className="flex items-center gap-4">
                                                <div className="flex flex-col items-center group/tip relative">
                                                    <span className="text-[8px] font-black text-slate-600 uppercase mb-1 opacity-50">Shopify</span>
                                                    {user.shopify_authorized
                                                        ? <div className="text-emerald-400 text-[10px] font-bold">● OK</div>
                                                        : <div className="text-amber-500 text-[10px] font-bold flex items-center gap-1">
                                                            ● {user.shopify_domain ? "ERR" : "OFF"}
                                                            {user.shopify_error && <HelpCircle className="w-2.5 h-2.5 opacity-50" />}
                                                        </div>
                                                    }
                                                    {user.shopify_error && (
                                                        <div className="absolute bottom-full mb-2 w-48 p-3 bg-slate-900 border border-slate-800 rounded-xl shadow-2xl opacity-0 group-hover/tip:opacity-100 transition-all pointer-events-none z-50">
                                                            <p className="text-[10px] text-amber-200/80 font-medium leading-tight">{user.shopify_error}</p>
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="flex flex-col items-center group/tip relative">
                                                    <span className="text-[8px] font-black text-slate-600 uppercase mb-1 opacity-50">IX API</span>
                                                    {user.ix_authorized
                                                        ? <div className="text-emerald-400 text-[10px] font-bold">● OK</div>
                                                        : <div className="text-amber-500 text-[10px] font-bold flex items-center gap-1">
                                                            ● ERR
                                                            {user.ix_error && <HelpCircle className="w-2.5 h-2.5 opacity-50" />}
                                                        </div>
                                                    }
                                                    {user.ix_error && (
                                                        <div className="absolute bottom-full mb-2 w-48 p-3 bg-slate-900 border border-slate-800 rounded-xl shadow-2xl opacity-0 group-hover/tip:opacity-100 transition-all pointer-events-none z-50">
                                                            <p className="text-[10px] text-amber-200/80 font-medium leading-tight">{user.ix_error}</p>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="flex flex-col items-center gap-1.5">
                                            <span className="text-[10px] font-black text-slate-700 uppercase tracking-widest leading-none">Domínio Loja</span>
                                            <span className="text-xs font-bold text-slate-300">{user.shopify_domain || "---"}</span>
                                        </div>
                                    </div>

                                    {/* Actions */}
                                    <div className="flex items-center gap-2 flex-wrap justify-center">
                                        {/* Impersonate */}
                                        {canImpersonate && (
                                            <button
                                                onClick={() => handleImpersonate(user.id)}
                                                disabled={acting !== null}
                                                className="bg-white text-black px-5 py-3 rounded-2xl font-black text-[10px] uppercase tracking-widest flex items-center gap-2 hover:bg-rose-500 hover:text-white transition-all duration-300 active:scale-95 disabled:opacity-30"
                                            >
                                                {acting === user.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserCog className="w-3 h-3" />}
                                                Impersonar
                                            </button>
                                        )}

                                        {/* Promote / Demote (superadmin only) */}
                                        {canPromote && (
                                            isUserAdmin ? (
                                                <button
                                                    onClick={() => handleRoleChange(user.id, "user")}
                                                    disabled={acting !== null}
                                                    title="Revogar Admin"
                                                    className="px-4 py-3 rounded-2xl font-black text-[10px] uppercase tracking-widest flex items-center gap-2 bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-all disabled:opacity-30"
                                                >
                                                    {acting === user.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldOff className="w-3 h-3" />}
                                                    Revogar
                                                </button>
                                            ) : (
                                                <button
                                                    onClick={() => handleRoleChange(user.id, "admin")}
                                                    disabled={acting !== null}
                                                    title="Promover a Admin"
                                                    className="px-4 py-3 rounded-2xl font-black text-[10px] uppercase tracking-widest flex items-center gap-2 bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-all disabled:opacity-30"
                                                >
                                                    {acting === user.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldPlus className="w-3 h-3" />}
                                                    Admin
                                                </button>
                                            )
                                        )}

                                        {/* Delete */}
                                        {canDelete && (
                                            deleteConfirm === user.id ? (
                                                <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-2xl px-4 py-2">
                                                    <span className="text-[10px] font-black text-red-400 uppercase tracking-wider">Confirmar?</span>
                                                    <button
                                                        onClick={() => handleDelete(user.id)}
                                                        className="p-1 rounded-lg bg-red-500 text-white hover:bg-red-600 transition-all"
                                                    >
                                                        <Check className="w-3 h-3" />
                                                    </button>
                                                    <button
                                                        onClick={() => setDeleteConfirm(null)}
                                                        className="p-1 rounded-lg bg-slate-800 text-slate-400 hover:bg-slate-700 transition-all"
                                                    >
                                                        <X className="w-3 h-3" />
                                                    </button>
                                                </div>
                                            ) : (
                                                <button
                                                    onClick={() => setDeleteConfirm(user.id)}
                                                    disabled={acting !== null}
                                                    title="Remover cliente"
                                                    className="px-3 py-3 rounded-2xl font-black text-[10px] flex items-center gap-2 bg-red-500/5 text-red-500/50 border border-red-500/10 hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/20 transition-all disabled:opacity-30"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                </button>
                                            )
                                        )}
                                    </div>
                                </div>
                            </motion.div>
                        );
                    })}
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
