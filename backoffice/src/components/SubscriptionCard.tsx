"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { CreditCard, Check, AlertTriangle, Clock, Sparkles, ArrowRight, Loader2, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

type UIState = "active" | "trialing_earlybird" | "trialing" | "blocked" | "none" | "exempt";

interface SubData {
    subscription: any | null;
    ui_state: UIState;
    blocked: boolean;
    role?: string;
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

    // Admins exempt — render compact info card
    if (state === "exempt") {
        return (
            <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
                className="glass rounded-[2rem] border-2 border-violet-500/30 bg-violet-500/[0.03] p-6 flex items-center gap-5">
                <div className="w-12 h-12 rounded-2xl bg-violet-500/15 ring-1 ring-violet-500/30 flex items-center justify-center shrink-0">
                    <ShieldCheck className="w-6 h-6 text-violet-400" />
                </div>
                <div>
                    <span className="px-2 py-0.5 rounded-md text-[9px] font-black uppercase tracking-widest border bg-violet-500/10 text-violet-400 border-violet-500/20">
                        Admin
                    </span>
                    <h3 className="text-lg font-black tracking-tight text-white mt-1">Conta isenta de subscrição</h3>
                    <p className="text-xs text-slate-500 font-medium">Integração corre sempre — sem cobranças.</p>
                </div>
            </motion.div>
        );
    }

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
            title: "Subscrição Early Bird",
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
    }[state as Exclude<UIState, "exempt">];

    const Icon = config.icon;
    const daysLeft = daysUntil(sub?.trial_end);

    const showCheckout = state !== "active";

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

            <div className="flex flex-col gap-8">
                {/* Header row */}
                <div className="flex flex-col lg:flex-row items-start lg:items-center gap-6">
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
                        <p className="text-sm text-slate-400 font-medium leading-relaxed max-w-2xl">
                            {state === "active" && sub?.current_period_end && `Próxima cobrança a ${formatDate(sub.current_period_end)}.`}
                            {state === "trialing_earlybird" && `Trial gratuito até 1 de Agosto de 2026 (${daysLeft} dias restantes). Adiciona dados de pagamento quando quiseres — cobrança automática a partir de 1 Ago.`}
                            {state === "trialing" && sub?.trial_end && `Trial termina a ${formatDate(sub.trial_end)} (${daysLeft} dias restantes). Cobrança automática.`}
                            {state === "blocked" && "A emissão automática de faturas para o InvoiceXpress está suspensa. Reativa para retomar a integração."}
                            {state === "none" && "Sem subscrição ativa. A integração Shopify → InvoiceXpress requer subscrição."}
                        </p>
                    </div>

                    {state === "active" && (
                        <Link
                            href="/faturacao"
                            className="px-6 py-3 rounded-2xl bg-white/5 border border-slate-800/50 text-white font-black text-xs uppercase tracking-widest hover:bg-white/10 transition-all flex items-center gap-3 shrink-0"
                        >
                            Gerir Faturação <ArrowRight className="w-4 h-4" />
                        </Link>
                    )}
                </div>

                {/* Plan selector + CTA (only when not active) */}
                {showCheckout && (
                    <div className="flex flex-col lg:flex-row gap-6 items-stretch">
                        <div className="grid grid-cols-2 gap-4 flex-1">
                            <button
                                onClick={() => setSelectedPlan("monthly")}
                                className={cn(
                                    "relative rounded-2xl border-2 p-6 text-left transition-all transform active:scale-[0.98]",
                                    selectedPlan === "monthly"
                                        ? "border-white bg-white/[0.07] shadow-xl"
                                        : "border-slate-800/60 bg-slate-900/30 hover:border-slate-700"
                                )}
                            >
                                <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Mensal</div>
                                <div className="flex items-baseline gap-1">
                                    <span className="text-4xl font-black text-white">7,50€</span>
                                    <span className="text-sm text-slate-500 font-bold">/mês</span>
                                </div>
                                <div className="text-[11px] text-slate-500 font-medium mt-2">+ IVA · cobrança mensal</div>
                                {selectedPlan === "monthly" && (
                                    <div className="absolute top-3 right-3 w-5 h-5 rounded-full bg-white flex items-center justify-center">
                                        <Check className="w-3 h-3 text-black stroke-[3]" />
                                    </div>
                                )}
                            </button>

                            <button
                                onClick={() => setSelectedPlan("annual")}
                                className={cn(
                                    "relative rounded-2xl border-2 p-6 text-left transition-all transform active:scale-[0.98]",
                                    selectedPlan === "annual"
                                        ? "border-emerald-400 bg-emerald-500/[0.08] shadow-xl shadow-emerald-500/10"
                                        : "border-slate-800/60 bg-slate-900/30 hover:border-slate-700"
                                )}
                            >
                                <div className="flex items-center gap-2 mb-2">
                                    <span className="text-[10px] font-black text-emerald-400 uppercase tracking-widest">Anual</span>
                                    <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 uppercase tracking-widest">poupa 17%</span>
                                </div>
                                <div className="flex items-baseline gap-1">
                                    <span className="text-4xl font-black text-white">75€</span>
                                    <span className="text-sm text-slate-500 font-bold">/ano</span>
                                </div>
                                <div className="text-[11px] text-slate-500 font-medium mt-2">+ IVA · equivale a 6,25€/mês</div>
                                {selectedPlan === "annual" && (
                                    <div className="absolute top-3 right-3 w-5 h-5 rounded-full bg-emerald-400 flex items-center justify-center">
                                        <Check className="w-3 h-3 text-black stroke-[3]" />
                                    </div>
                                )}
                            </button>
                        </div>

                        <button
                            disabled={acting}
                            onClick={startCheckout}
                            className={cn(
                                "px-8 py-4 rounded-2xl font-black text-sm uppercase tracking-widest transition-all transform active:scale-95 flex items-center justify-center gap-3 shadow-xl shrink-0 min-w-[260px]",
                                state === "blocked"
                                    ? "bg-red-500 text-white hover:bg-red-400 shadow-red-500/20"
                                    : state === "trialing_earlybird"
                                        ? "bg-amber-400 text-black hover:bg-amber-300 shadow-amber-400/20"
                                        : "bg-white text-black hover:bg-emerald-400 hover:text-white shadow-white/5",
                                acting && "opacity-50 cursor-not-allowed"
                            )}
                        >
                            {acting && <Loader2 className="w-4 h-4 animate-spin" />}
                            {!acting && state === "blocked" && "Reativar"}
                            {!acting && state === "trialing_earlybird" && "Adicionar Pagamento"}
                            {!acting && state === "none" && "Subscrever"}
                            {!acting && state === "trialing" && "Atualizar"}
                            {!acting && <ArrowRight className="w-4 h-4" />}
                        </button>
                    </div>
                )}
            </div>
        </motion.div>
    );
}
