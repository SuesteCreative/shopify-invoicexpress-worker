"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { CreditCard, Check, AlertTriangle, Clock, Sparkles, ArrowRight, Loader2 } from "lucide-react";
import Link from "next/link";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

type UIState = "active" | "trialing_earlybird" | "trialing" | "blocked" | "none";

interface SubData {
    subscription: any | null;
    ui_state: UIState;
    blocked: boolean;
}

function formatDate(iso?: string | null): string {
    if (!iso) return "";
    try {
        return new Date(iso).toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit", year: "numeric" });
    } catch { return ""; }
}

function daysUntil(iso?: string | null): number | null {
    if (!iso) return null;
    const diff = new Date(iso).getTime() - Date.now();
    return Math.max(0, Math.ceil(diff / 86400000));
}

export default function SubscriptionCard({ onSuccess }: { onSuccess?: boolean }) {
    const [data, setData] = useState<SubData | null>(null);
    const [loading, setLoading] = useState(true);
    const [acting, setActing] = useState(false);
    const [selectedPlan, setSelectedPlan] = useState<"monthly" | "annual">("annual");

    const refresh = async () => {
        try {
            const res = await fetch("/api/billing/subscription");
            const d = await res.json() as SubData;
            setData(d);
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { refresh(); }, []);

    const startCheckout = async () => {
        setActing(true);
        try {
            const res = await fetch("/api/billing/checkout", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ plan: selectedPlan }),
            });
            const d = (await res.json()) as { url?: string; error?: string };
            if (d.url) {
                window.location.href = d.url;
            } else {
                alert(d.error || "Erro ao iniciar checkout");
                setActing(false);
            }
        } catch (e: any) {
            alert(e.message);
            setActing(false);
        }
    };

    if (loading) {
        return (
            <div className="glass rounded-[2rem] p-8 flex items-center justify-center min-h-[180px]">
                <Loader2 className="w-6 h-6 text-slate-500 animate-spin" />
            </div>
        );
    }

    const state = data?.ui_state ?? "none";
    const sub = data?.subscription;

    const config = {
        active: {
            ring: "border-emerald-500/40 bg-emerald-500/[0.03]",
            iconBg: "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30",
            badge: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
            badgeText: "Ativa",
            title: "Subscrição ativa",
            icon: Check,
        },
        trialing_earlybird: {
            ring: "border-amber-400/40 bg-amber-500/[0.03]",
            iconBg: "bg-amber-500/15 text-amber-400 ring-amber-500/30",
            badge: "bg-amber-500/10 text-amber-400 border-amber-500/20",
            badgeText: "Early Bird",
            title: "És um early adopter",
            icon: Sparkles,
        },
        trialing: {
            ring: "border-sky-400/40 bg-sky-500/[0.03]",
            iconBg: "bg-sky-500/15 text-sky-400 ring-sky-500/30",
            badge: "bg-sky-500/10 text-sky-400 border-sky-500/20",
            badgeText: "Trial",
            title: "Trial em curso",
            icon: Clock,
        },
        blocked: {
            ring: "border-red-500/40 bg-red-500/[0.04]",
            iconBg: "bg-red-500/15 text-red-400 ring-red-500/30",
            badge: "bg-red-500/15 text-red-400 border-red-500/30",
            badgeText: "Integração parada",
            title: "Subscrição inativa",
            icon: AlertTriangle,
        },
        none: {
            ring: "border-slate-700/40",
            iconBg: "bg-slate-800/50 text-slate-400 ring-slate-700/30",
            badge: "bg-slate-700/30 text-slate-400 border-slate-600/30",
            badgeText: "Sem subscrição",
            title: "Subscreve o Rioko 2.0",
            icon: CreditCard,
        },
    }[state];

    const Icon = config.icon;
    const daysLeft = daysUntil(sub?.trial_end);

    return (
        <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className={cn("glass rounded-[2rem] border-2 p-8 relative overflow-hidden", config.ring)}
        >
            {onSuccess && (
                <motion.div initial={{ y: -40 }} animate={{ y: 0 }} className="absolute top-0 left-0 right-0 bg-emerald-500/20 text-emerald-300 text-center py-2 text-xs font-bold uppercase tracking-widest">
                    ✓ Subscrição ativada com sucesso
                </motion.div>
            )}

            <div className="flex flex-col lg:flex-row items-start lg:items-center gap-8">
                <div className={cn("w-16 h-16 rounded-2xl flex items-center justify-center ring-1 shrink-0", config.iconBg)}>
                    <Icon className="w-7 h-7 stroke-[2]" />
                </div>

                <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-3 flex-wrap">
                        <span className={cn("px-2 py-0.5 rounded-md text-[9px] font-black uppercase tracking-widest border", config.badge)}>
                            {config.badgeText}
                        </span>
                        {sub?.plan && (
                            <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">
                                {sub.plan === "annual" ? "Anual · 75€/ano" : "Mensal · 7,50€/mês"}
                            </span>
                        )}
                        {sub?.cancel_at_period_end === 1 && (
                            <span className="px-2 py-0.5 rounded-md text-[9px] font-black uppercase tracking-widest border bg-orange-500/10 text-orange-400 border-orange-500/20">
                                Cancela {formatDate(sub.current_period_end)}
                            </span>
                        )}
                    </div>
                    <h3 className="text-2xl font-black tracking-tight text-white">{config.title}</h3>
                    <p className="text-sm text-slate-400 font-medium leading-relaxed max-w-xl">
                        {state === "active" && sub?.current_period_end && `Próxima cobrança a ${formatDate(sub.current_period_end)}.`}
                        {state === "trialing_earlybird" && `Trial gratuito até 1 de Agosto de 2026 (${daysLeft} dias restantes). Adiciona dados de pagamento quando quiseres — cobrança automática a partir de 1 Ago.`}
                        {state === "trialing" && sub?.trial_end && `Trial termina a ${formatDate(sub.trial_end)} (${daysLeft} dias restantes). Cobrança automática.`}
                        {state === "blocked" && "A emissão automática de faturas para o InvoiceXpress está suspensa. Reativa para retomar a integração."}
                        {state === "none" && "Sem subscrição ativa. A integração Shopify → InvoiceXpress requer subscrição."}
                    </p>
                </div>

                <div className="flex flex-col gap-3 lg:items-end shrink-0">
                    {state === "active" && (
                        <Link
                            href="/faturacao"
                            className="px-6 py-3 rounded-2xl bg-white/5 border border-slate-800/50 text-white font-black text-xs uppercase tracking-widest hover:bg-white/10 transition-all flex items-center gap-3"
                        >
                            Gerir Faturação <ArrowRight className="w-4 h-4" />
                        </Link>
                    )}

                    {(state === "trialing_earlybird" || state === "blocked" || state === "none" || state === "trialing") && (
                        <>
                            <div className="flex bg-slate-900/50 border border-slate-800/50 rounded-2xl p-1">
                                <button onClick={() => setSelectedPlan("monthly")} className={cn("px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all", selectedPlan === "monthly" ? "bg-white text-black" : "text-slate-400 hover:text-white")}>
                                    Mensal 7,50€
                                </button>
                                <button onClick={() => setSelectedPlan("annual")} className={cn("px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-2", selectedPlan === "annual" ? "bg-white text-black" : "text-slate-400 hover:text-white")}>
                                    Anual 75€
                                    {selectedPlan !== "annual" && <span className="text-[8px] text-emerald-400">-17%</span>}
                                </button>
                            </div>
                            <button
                                disabled={acting}
                                onClick={startCheckout}
                                className={cn(
                                    "px-8 py-4 rounded-2xl font-black text-xs uppercase tracking-widest transition-all transform active:scale-95 flex items-center gap-3 shadow-xl",
                                    state === "blocked"
                                        ? "bg-red-500 text-white hover:bg-red-400 shadow-red-500/20"
                                        : state === "trialing_earlybird"
                                            ? "bg-amber-400 text-black hover:bg-amber-300 shadow-amber-400/20"
                                            : "bg-white text-black hover:bg-emerald-400 hover:text-white shadow-white/5",
                                    acting && "opacity-50 cursor-not-allowed"
                                )}
                            >
                                {acting && <Loader2 className="w-4 h-4 animate-spin" />}
                                {state === "blocked" && "Reativar Subscrição"}
                                {state === "trialing_earlybird" && "Adicionar Dados de Pagamento"}
                                {state === "none" && "Subscrever"}
                                {state === "trialing" && "Atualizar Subscrição"}
                                {!acting && <ArrowRight className="w-4 h-4" />}
                            </button>
                        </>
                    )}
                </div>
            </div>
        </motion.div>
    );
}
