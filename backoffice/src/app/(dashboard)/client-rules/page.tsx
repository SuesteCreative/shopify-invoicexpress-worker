"use client";

export const runtime = "edge";

import { useState, useEffect, useMemo } from "react";
import { Loader2, Settings2, Check, X, Store, Webhook, FileText, ToggleLeft, ToggleRight, AlertTriangle, Search, ArrowUpDown, Clock } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

interface ClientRule {
    id: string;
    name: string;
    email: string;
    shopify_domain: string;
    ix_account_name: string;
    ix_environment: string;
    vat_included: number;
    auto_finalize: number;
    ix_exemption_reason: string;
    pos_mode: number;
    webhooks_active: number;
    shopify_authorized: number;
    ix_authorized: number;
    shopify_forced_at?: string;
    webhooks_forced_at?: string;
    ix_forced_at?: string;
}

const Toggle = ({ value, onChange, label, description, warn }: {
    value: boolean;
    onChange: (v: boolean) => void;
    label: string;
    description: string;
    warn?: string;
}) => (
    <div className="flex items-start justify-between gap-4 py-3 border-b border-slate-800/40 last:border-0">
        <div className="flex-1">
            <p className="text-sm font-bold text-slate-200">{label}</p>
            <p className="text-[11px] text-slate-500 mt-0.5">{description}</p>
            {warn && value && (
                <p className="text-[10px] text-amber-400 mt-1 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" />{warn}
                </p>
            )}
        </div>
        <button onClick={() => onChange(!value)} className="shrink-0 mt-0.5">
            {value
                ? <ToggleRight className="w-8 h-8 text-emerald-400" />
                : <ToggleLeft className="w-8 h-8 text-slate-600" />
            }
        </button>
    </div>
);

export default function ClientRulesPage() {
    const [clients, setClients] = useState<ClientRule[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [sortOrder, setSortOrder] = useState<"desc" | "asc">("desc");

    useEffect(() => { fetchClients(); }, []);

    const fetchClients = async () => {
        setLoading(true);
        try {
            const res = await fetch("/api/admin/client-rules");
            setClients(await res.json() as ClientRule[]);
        } finally {
            setLoading(false);
        }
    };

    const updateFlag = async (userId: string, flag: string, value: number) => {
        setSaving(`${userId}-${flag}`);
        try {
            await fetch("/api/admin/client-rules", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetUserId: userId, flag, value })
            });
            setClients((prev: ClientRule[]) => prev.map(c => c.id === userId ? { ...c, [flag]: value } : c));
        } finally {
            setSaving(null);
        }
    };

    const filtered = useMemo(() =>
        clients
            .filter((c: ClientRule) =>
                c.name.toLowerCase().includes(search.toLowerCase()) ||
                c.email.toLowerCase().includes(search.toLowerCase()) ||
                c.shopify_domain?.toLowerCase().includes(search.toLowerCase())
            )
            .sort((a: ClientRule, b: ClientRule) => {
                // Since we don't have created_at in ClientRule yet, we'll just sort by name for now or ID
                return sortOrder === "desc" ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name);
            }),
        [clients, search, sortOrder]);

    if (loading) return (
        <div className="min-h-[60vh] flex items-center justify-center">
            <Loader2 className="w-12 h-12 text-violet-500 animate-spin opacity-50" />
        </div>
    );

    return (
        <div className="space-y-12 animate-in fade-in duration-1000 slide-in-from-bottom-4">
            <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-8">
                <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-3">
                        <Settings2 className="w-8 h-8 text-violet-500" />
                        <h1 className="text-5xl font-black tracking-tight bg-gradient-to-r from-white via-white to-slate-500 bg-clip-text text-transparent">
                            Regras
                        </h1>
                    </div>
                    <p className="text-slate-400 font-semibold tracking-wide">
                        Configurações e overrides activos. Exclusivo Hiperadmin.
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-4">
                    <div className="relative group">
                        <Search className="w-4 h-4 text-slate-500 absolute left-4 top-1/2 -translate-y-1/2 group-focus-within:text-violet-500 transition-colors" />
                        <input
                            type="text" placeholder="Nome, email ou domínio..."
                            value={search} onChange={e => setSearch(e.target.value)}
                            className="bg-slate-900/50 border border-slate-800/60 rounded-2xl py-3 pl-12 pr-6 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500/40 w-full lg:w-80 transition-all"
                        />
                    </div>
                    <button
                        onClick={() => setSortOrder((p: string) => p === "desc" ? "asc" : "desc")}
                        className="bg-slate-900/50 border border-slate-800/60 rounded-2xl px-5 py-3 text-xs font-black uppercase tracking-widest flex items-center gap-3 hover:bg-slate-800/80 transition-all active:scale-95"
                    >
                        <ArrowUpDown className="w-4 h-4 text-violet-500" />
                        {sortOrder === "desc" ? "Z-A" : "A-Z"}
                    </button>
                </div>
            </div>

            <div className="grid gap-6">
                <AnimatePresence mode="popLayout">
                    {filtered.map((client: ClientRule) => (
                        <motion.div
                            key={client.id}
                            layout
                            initial={{ opacity: 0, scale: 0.98 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.98 }}
                            className="glass rounded-[2rem] p-8 border-slate-800/40 hover:border-slate-700/60 transition-all"
                        >
                            {/* Client header */}
                            <div className="flex items-start justify-between mb-6 pb-6 border-b border-slate-800/40">
                                <div>
                                    <h2 className="text-xl font-bold">{client.name}</h2>
                                    <p className="text-slate-500 text-sm">{client.email}</p>
                                    <div className="flex items-center gap-4 mt-4 flex-wrap">
                                        {client.shopify_domain && (
                                            <span className="flex items-center gap-1.5 text-[10px] text-slate-500 font-bold uppercase tracking-widest">
                                                <Store className="w-3 h-3 text-emerald-500" />
                                                {client.shopify_domain}
                                            </span>
                                        )}
                                        {client.ix_account_name && (
                                            <span className="flex items-center gap-1.5 text-[10px] text-slate-500 font-bold uppercase tracking-widest">
                                                <FileText className="w-3 h-3 text-blue-400" />
                                                {client.ix_account_name}
                                            </span>
                                        )}
                                    </div>
                                </div>
                                <div className="flex flex-col items-end gap-2 text-right">
                                    <div className="text-[10px] font-black text-slate-600 uppercase tracking-widest bg-slate-900/50 px-3 py-1 rounded-lg border border-slate-800/50">
                                        Isenção: {client.ix_exemption_reason || "M01"}
                                    </div>
                                    <div className="flex gap-2">
                                        {client.shopify_authorized === 1 && (
                                            <div className="flex flex-col items-end">
                                                <div className="px-2 py-1 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-[9px] font-black text-emerald-400 uppercase tracking-tighter flex items-center gap-1">
                                                    <Check className="w-2.5 h-2.5" /> Shopify Force
                                                </div>
                                                {client.shopify_forced_at && (
                                                    <span className="text-[7px] text-slate-600 font-bold mt-0.5 uppercase tracking-tighter">
                                                        Ativado: {new Date(client.shopify_forced_at).toLocaleString("pt-PT")}
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                        {client.webhooks_active === 1 && (
                                            <div className="flex flex-col items-end">
                                                <div className="px-2 py-1 rounded-md bg-violet-500/10 border border-violet-500/20 text-[9px] font-black text-violet-400 uppercase tracking-tighter flex items-center gap-1">
                                                    <Webhook className="w-2.5 h-2.5" /> Webhook Force
                                                </div>
                                                {client.webhooks_forced_at && (
                                                    <span className="text-[7px] text-slate-600 font-bold mt-0.5 uppercase tracking-tighter">
                                                        Ativado: {new Date(client.webhooks_forced_at).toLocaleString("pt-PT")}
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                        {client.ix_authorized === 1 && (
                                            <div className="flex flex-col items-end">
                                                <div className="px-2 py-1 rounded-md bg-blue-500/10 border border-blue-500/20 text-[9px] font-black text-blue-400 uppercase tracking-tighter flex items-center gap-1">
                                                    <Check className="w-2.5 h-2.5" /> IX Force
                                                </div>
                                                {client.ix_forced_at && (
                                                    <span className="text-[7px] text-slate-600 font-bold mt-0.5 uppercase tracking-tighter">
                                                        Ativado: {new Date(client.ix_forced_at).toLocaleString("pt-PT")}
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* Toggleable flags */}
                            <div className="space-y-0">
                                <Toggle
                                    value={client.pos_mode === 1}
                                    onChange={v => updateFlag(client.id, "pos_mode", v ? 1 : 0)}
                                    label="🏪 Modo POS (NIF Matrix)"
                                    description="Activa a resolução de nome por NIF para lojas físicas. Em vez de 'Consumidor Final', usa 'NIF XXXXXXXXX' como identificador único quando não há nome de cliente."
                                    warn="Activado: os clientes sem nome serão identificados pelo NIF na ficha do InvoiceXpress."
                                />
                                <Toggle
                                    value={client.vat_included === 1}
                                    onChange={v => updateFlag(client.id, "vat_included", v ? 1 : 0)}
                                    label="💰 IVA Incluído nos Preços"
                                    description="Se os preços da loja Shopify já incluem IVA, o Rioko faz o cálculo inverso para a fatura."
                                />
                                <Toggle
                                    value={client.auto_finalize === 1}
                                    onChange={v => updateFlag(client.id, "auto_finalize", v ? 1 : 0)}
                                    label="⚡ Finalizar Automaticamente"
                                    description="As faturas são emitidas e finalizadas imediatamente após a criação. Se desligado, ficam em rascunho."
                                    warn="Faturas finalizadas não podem ser editadas no InvoiceXpress."
                                />
                            </div>

                            {saving && saving.startsWith(client.id) && (
                                <div className="mt-4 flex items-center gap-2 text-[10px] text-slate-500 font-bold">
                                    <Loader2 className="w-3 h-3 animate-spin" /> A guardar...
                                </div>
                            )}
                        </motion.div>
                    ))}
                </AnimatePresence>

                {clients.length === 0 && (
                    <div className="text-center py-20 text-slate-600 font-bold text-sm">
                        Nenhum cliente com integração configurada.
                    </div>
                )}
            </div>
        </div>
    );
}
