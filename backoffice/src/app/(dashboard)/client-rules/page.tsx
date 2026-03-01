"use client";

export const runtime = "edge";

import { useState, useEffect } from "react";
import { Loader2, Settings2, Check, X, Store, Webhook, FileText, ToggleLeft, ToggleRight, AlertTriangle } from "lucide-react";
import { motion } from "framer-motion";

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
            setClients(prev => prev.map(c => c.id === userId ? { ...c, [flag]: value } : c));
        } finally {
            setSaving(null);
        }
    };

    if (loading) return (
        <div className="min-h-[60vh] flex items-center justify-center">
            <Loader2 className="w-12 h-12 text-violet-500 animate-spin opacity-50" />
        </div>
    );

    return (
        <div className="space-y-12 animate-in fade-in duration-1000 slide-in-from-bottom-4">
            <div className="flex flex-col gap-2">
                <div className="flex items-center gap-3">
                    <Settings2 className="w-8 h-8 text-violet-500" />
                    <h1 className="text-5xl font-black tracking-tight bg-gradient-to-r from-white via-white to-slate-500 bg-clip-text text-transparent">
                        Regras de Clientes
                    </h1>
                </div>
                <p className="text-slate-400 font-semibold tracking-wide">
                    Configurações e flags personalizadas por conta de cliente. Exclusivo Hiperadmin.
                </p>
            </div>

            <div className="grid gap-6">
                {clients.map(client => (
                    <motion.div
                        key={client.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="glass rounded-[2rem] p-8 border-slate-800/40"
                    >
                        {/* Client header */}
                        <div className="flex items-start justify-between mb-6 pb-6 border-b border-slate-800/40">
                            <div>
                                <h2 className="text-xl font-bold">{client.name}</h2>
                                <p className="text-slate-500 text-sm">{client.email}</p>
                                <div className="flex items-center gap-4 mt-2 flex-wrap">
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
                                            {client.ix_environment !== "production" && (
                                                <span className="px-1.5 py-0.5 bg-amber-500/10 text-amber-400 rounded text-[9px] border border-amber-500/20">sandbox</span>
                                            )}
                                        </span>
                                    )}
                                    <span className="flex items-center gap-1.5 text-[10px] text-slate-500 font-bold uppercase tracking-widest">
                                        <Webhook className="w-3 h-3 text-violet-400" />
                                        Webhooks: {client.webhooks_active ? "✅" : "❌"}
                                    </span>
                                </div>
                            </div>
                            <div className="text-[10px] font-black text-slate-600 uppercase tracking-widest">
                                Isenção: {client.ix_exemption_reason || "M01"}
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
                            <Toggle
                                value={client.shopify_authorized === 1}
                                onChange={v => updateFlag(client.id, "shopify_authorized", v ? 1 : 0)}
                                label="🛍️ Ligação Shopify (Override Manual)"
                                description="Força o estado da ligação Shopify como autorizada, contornando o erro de diagnóstico se o token expirar ou for de teste."
                            />
                            <Toggle
                                value={client.webhooks_active === 1}
                                onChange={v => updateFlag(client.id, "webhooks_active", v ? 1 : 0)}
                                label="🔗 Webhooks (Override Manual)"
                                description="Override manual do estado dos webhooks. Activa se os webhooks estão instalados mas o token não tem read_webhooks para verificar."
                            />
                            <Toggle
                                value={client.ix_authorized === 1}
                                onChange={v => updateFlag(client.id, "ix_authorized", v ? 1 : 0)}
                                label="💳 Ligação InvoiceXpress (Override Manual)"
                                description="Força o estado da ligação InvoiceXpress como autorizada, ignorando falhas de API no diagnóstico."
                            />
                        </div>

                        {saving && saving.startsWith(client.id) && (
                            <div className="mt-4 flex items-center gap-2 text-[10px] text-slate-500 font-bold">
                                <Loader2 className="w-3 h-3 animate-spin" /> A guardar...
                            </div>
                        )}
                    </motion.div>
                ))}

                {clients.length === 0 && (
                    <div className="text-center py-20 text-slate-600 font-bold text-sm">
                        Nenhum cliente com integração configurada.
                    </div>
                )}
            </div>
        </div>
    );
}
