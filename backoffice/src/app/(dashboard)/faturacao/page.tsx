"use client";

export const runtime = "edge";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Receipt, ExternalLink, Loader2, CreditCard, AlertCircle, CheckCircle2, XCircle, Clock, RefreshCw } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

interface BillingEvent {
    id: string;
    type: "invoice.paid" | "invoice.payment_failed" | "charge.refunded" | string;
    stripe_object_id: string;
    payment_intent_id: string | null;
    amount_cents: number;
    currency: string;
    status: string;
    ix_invoice_id: string | null;
    ix_invoice_permalink: string | null;
    ix_match_method: string | null;
    ix_match_score: number | null;
    created_at: string;
}

function formatAmount(cents: number, currency: string): string {
    return new Intl.NumberFormat("pt-PT", { style: "currency", currency: (currency || "eur").toUpperCase() }).format(cents / 100);
}

function formatDate(iso: string): string {
    return new Date(iso).toLocaleString("pt-PT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatRef(pi: string | null, invId: string): string {
    if (pi) return `#stripe ${pi}`;
    return `#stripe ${invId}`;
}

function statusBadge(status: string, type: string) {
    if (type === "charge.refunded") {
        return (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-widest border bg-orange-500/10 text-orange-400 border-orange-500/20">
                <RefreshCw className="w-3 h-3" />
                Reembolso
            </span>
        );
    }
    const config: Record<string, { bg: string; label: string; icon: any }> = {
        paid: { bg: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20", label: "Pago", icon: CheckCircle2 },
        failed: { bg: "bg-red-500/10 text-red-400 border-red-500/20", label: "Falhou", icon: XCircle },
        open: { bg: "bg-amber-500/10 text-amber-400 border-amber-500/20", label: "Aberto", icon: Clock },
        void: { bg: "bg-slate-500/10 text-slate-400 border-slate-500/20", label: "Anulado", icon: XCircle },
        uncollectible: { bg: "bg-red-500/10 text-red-400 border-red-500/20", label: "Incobrável", icon: AlertCircle },
    };
    const c = config[status] || { bg: "bg-slate-500/10 text-slate-400 border-slate-500/20", label: status, icon: Clock };
    const Icon = c.icon;
    return (
        <span className={cn("inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-widest border", c.bg)}>
            <Icon className="w-3 h-3" />
            {c.label}
        </span>
    );
}

export default function FaturacaoPage() {
    const [sub, setSub] = useState<any>(null);
    const [events, setEvents] = useState<BillingEvent[]>([]);
    const [loading, setLoading] = useState(true);
    const [acting, setActing] = useState<string | null>(null);

    const load = async () => {
        try {
            const [subRes, invRes] = await Promise.all([
                fetch("/api/billing/subscription").then(r => r.json() as Promise<any>),
                fetch("/api/billing/invoices").then(r => r.json() as Promise<any>),
            ]);
            setSub(subRes);
            setEvents(invRes.events || []);
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { load(); }, []);

    const handleUpdateCard = async () => {
        setActing("update");
        try {
            const r = await fetch("/api/billing/update-card", { method: "POST" });
            const d: any = await r.json();
            if (d.url) window.location.href = d.url;
            else alert(d.error || "Erro");
        } finally {
            setActing(null);
        }
    };

    const handleCancel = async () => {
        if (!confirm("Cancelar a subscrição? Continuarás com acesso até ao fim do período pago.")) return;
        setActing("cancel");
        try {
            const r = await fetch("/api/billing/cancel", { method: "POST" });
            const d: any = await r.json();
            if (d.success) await load();
            else alert(d.error || "Erro");
        } finally {
            setActing(null);
        }
    };

    const handleReactivate = async () => {
        setActing("reactivate");
        try {
            const r = await fetch("/api/billing/reactivate", { method: "POST" });
            const d: any = await r.json();
            if (d.success) await load();
            else alert(d.error || "Erro");
        } finally {
            setActing(null);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-[400px]">
                <Loader2 className="w-8 h-8 text-slate-500 animate-spin" />
            </div>
        );
    }

    const s = sub?.subscription;
    const uiState = sub?.ui_state;
    const hasSubscription = !!s?.stripe_subscription_id;

    return (
        <div className="max-w-6xl mx-auto space-y-12 animate-in fade-in duration-1000 slide-in-from-bottom-4">
            <div className="space-y-4">
                <h1 className="text-5xl font-black tracking-tight bg-gradient-to-r from-white via-white/80 to-slate-500 bg-clip-text text-transparent">
                    Faturação
                </h1>
                <p className="text-slate-400 font-semibold tracking-wide">
                    Subscrição Rioko 2.0 · Histórico de cobranças e faturas InvoiceXpress
                </p>
            </div>

            {/* Subscription summary card */}
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="glass rounded-[2rem] p-8">
                <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
                    <div className="flex items-center gap-6">
                        <div className="w-16 h-16 rounded-2xl bg-sky-500/15 ring-1 ring-sky-500/30 flex items-center justify-center">
                            <CreditCard className="w-7 h-7 text-sky-400" />
                        </div>
                        <div className="space-y-2">
                            <div className="flex items-center gap-3 flex-wrap">
                                <span className={cn(
                                    "px-2 py-0.5 rounded-md text-[9px] font-black uppercase tracking-widest border",
                                    uiState === "active" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" :
                                    uiState === "trialing_earlybird" ? "bg-amber-500/10 text-amber-400 border-amber-500/20" :
                                    uiState === "trialing" ? "bg-sky-500/10 text-sky-400 border-sky-500/20" :
                                    uiState === "blocked" ? "bg-red-500/10 text-red-400 border-red-500/20" :
                                    "bg-slate-500/10 text-slate-400 border-slate-500/20"
                                )}>
                                    {uiState === "active" ? "Ativa" : uiState === "trialing_earlybird" ? "Early Bird" : uiState === "trialing" ? "Trial" : uiState === "blocked" ? "Inativa" : "Sem subscrição"}
                                </span>
                                {s?.plan && (
                                    <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">
                                        {s.plan === "annual" ? "Anual · 75€/ano" : "Mensal · 7,50€/mês"}
                                    </span>
                                )}
                                {s?.cancel_at_period_end === 1 && (
                                    <span className="px-2 py-0.5 rounded-md text-[9px] font-black uppercase tracking-widest border bg-orange-500/10 text-orange-400 border-orange-500/20">
                                        Cancela {s.current_period_end ? new Date(s.current_period_end).toLocaleDateString("pt-PT") : ""}
                                    </span>
                                )}
                            </div>
                            <h3 className="text-2xl font-black tracking-tight">{s?.name || "Subscrição Rioko 2.0"}</h3>
                            {s?.email && <p className="text-sm text-slate-500 font-medium">{s.email}{s.nif && <> · NIF {s.nif}</>}</p>}
                        </div>
                    </div>

                    {hasSubscription && (
                        <div className="flex flex-wrap gap-3">
                            <button onClick={handleUpdateCard} disabled={!!acting} className="px-5 py-3 rounded-2xl bg-white/5 border border-slate-800/50 text-white font-black text-[10px] uppercase tracking-widest hover:bg-white/10 transition-all flex items-center gap-2 disabled:opacity-50">
                                {acting === "update" ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
                                Mudar cartão
                            </button>
                            {s?.cancel_at_period_end === 1 ? (
                                <button onClick={handleReactivate} disabled={!!acting} className="px-5 py-3 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 font-black text-[10px] uppercase tracking-widest hover:bg-emerald-500/25 transition-all flex items-center gap-2 disabled:opacity-50">
                                    {acting === "reactivate" ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                                    Reativar
                                </button>
                            ) : (
                                <button onClick={handleCancel} disabled={!!acting} className="px-5 py-3 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-400 font-black text-[10px] uppercase tracking-widest hover:bg-red-500/20 transition-all flex items-center gap-2 disabled:opacity-50">
                                    {acting === "cancel" ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
                                    Cancelar
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </motion.div>

            {/* Events table */}
            <section className="space-y-4">
                <div className="flex items-center gap-3">
                    <Receipt className="w-5 h-5 text-slate-500" />
                    <h2 className="text-[11px] font-black text-slate-500 uppercase tracking-[0.2em]">Histórico de Cobranças</h2>
                </div>

                {events.length === 0 ? (
                    <div className="glass rounded-[2rem] p-16 text-center">
                        <Receipt className="w-12 h-12 text-slate-700 mx-auto mb-4" />
                        <p className="text-slate-500 font-bold text-sm">Ainda não há cobranças registadas.</p>
                    </div>
                ) : (
                    <div className="glass rounded-[2rem] overflow-hidden">
                        <table className="w-full">
                            <thead className="bg-slate-900/50 border-b border-slate-800/50">
                                <tr>
                                    <th className="text-left px-6 py-4 text-[10px] font-black text-slate-500 uppercase tracking-widest">Data</th>
                                    <th className="text-left px-6 py-4 text-[10px] font-black text-slate-500 uppercase tracking-widest">Referência</th>
                                    <th className="text-right px-6 py-4 text-[10px] font-black text-slate-500 uppercase tracking-widest">Valor</th>
                                    <th className="text-left px-6 py-4 text-[10px] font-black text-slate-500 uppercase tracking-widest">Estado</th>
                                    <th className="text-left px-6 py-4 text-[10px] font-black text-slate-500 uppercase tracking-widest">Fatura IX</th>
                                </tr>
                            </thead>
                            <tbody>
                                {events.map((e) => {
                                    const isRefund = e.type === "charge.refunded";
                                    return (
                                        <tr key={e.id} className={cn("border-b border-slate-800/30 hover:bg-white/[0.02] transition-colors", isRefund && "bg-orange-500/[0.02]")}>
                                            <td className="px-6 py-4 text-sm text-slate-300 font-medium">{formatDate(e.created_at)}</td>
                                            <td className="px-6 py-4 text-xs text-slate-400 font-mono">{formatRef(e.payment_intent_id, e.stripe_object_id)}</td>
                                            <td className={cn("px-6 py-4 text-sm font-black text-right", isRefund ? "text-orange-300" : "text-white")}>
                                                {isRefund ? "-" : ""}{formatAmount(e.amount_cents, e.currency)}
                                            </td>
                                            <td className="px-6 py-4">{statusBadge(e.status, e.type)}</td>
                                            <td className="px-6 py-4">
                                                {e.ix_invoice_permalink ? (
                                                    <a href={e.ix_invoice_permalink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-xs font-bold text-sky-400 hover:text-sky-300 transition-colors">
                                                        {isRefund ? "Ver nota crédito" : "Ver fatura"}
                                                        <ExternalLink className="w-3 h-3" />
                                                        {e.ix_match_method === "heuristic" && (
                                                            <span className="text-[9px] text-amber-400 font-black uppercase tracking-widest" title={`Match heurístico · score ${e.ix_match_score}`}>~</span>
                                                        )}
                                                    </a>
                                                ) : (
                                                    <span className="text-[10px] text-slate-600 font-bold uppercase tracking-widest">A processar</span>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>
        </div>
    );
}
