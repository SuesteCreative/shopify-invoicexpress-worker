"use client";

export const runtime = "edge";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { Receipt, ExternalLink, Loader2, CreditCard, AlertCircle, CheckCircle2, XCircle, Clock, RefreshCw, CheckCheck, Zap } from "lucide-react";
import { useTranslations } from "next-intl";
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

function StatusBadge({ status, type, t }: { status: string; type: string; t: (k: string) => string }) {
    if (type === "charge.refunded") {
        return (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md font-mono text-[10px] uppercase tracking-[0.18em] border bg-[rgba(244,63,94,0.10)] text-destructive border-[rgba(244,63,94,0.20)]">
                <RefreshCw className="w-3 h-3" />
                {t("badgeRefund")}
            </span>
        );
    }
    const config: Record<string, { bg: string; labelKey: string; icon: any }> = {
        paid: { bg: "bg-[rgba(94,234,212,0.10)] text-accent-hot border-[rgba(94,234,212,0.20)]", labelKey: "badgePaid", icon: CheckCircle2 },
        failed: { bg: "bg-[rgba(244,63,94,0.10)] text-destructive border-[rgba(244,63,94,0.20)]", labelKey: "badgeFailed", icon: XCircle },
        open: { bg: "bg-[rgba(245,158,11,0.10)] text-soon border-[rgba(245,158,11,0.20)]", labelKey: "badgeOpen", icon: Clock },
        void: { bg: "bg-surface-2 text-fg-40 border-hairline", labelKey: "badgeVoid", icon: XCircle },
        uncollectible: { bg: "bg-[rgba(244,63,94,0.10)] text-destructive border-[rgba(244,63,94,0.20)]", labelKey: "badgeUncollectible", icon: AlertCircle },
    };
    const c = config[status];
    const label = c ? t(c.labelKey) : status;
    const bg = c?.bg ?? "bg-surface-2 text-fg-40 border-hairline";
    const Icon = c?.icon ?? Clock;
    return (
        <span className={cn("inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md font-mono text-[10px] uppercase tracking-[0.18em] border", bg)}>
            <Icon className="w-3 h-3" />
            {label}
        </span>
    );
}

export default function FaturacaoPage() {
    const t = useTranslations("faturacao");
    const searchParams = useSearchParams();
    const stripeResult = searchParams.get("stripe");
    const [sub, setSub] = useState<any>(null);
    const [events, setEvents] = useState<BillingEvent[]>([]);
    const [loading, setLoading] = useState(true);
    const [acting, setActing] = useState<string | null>(null);
    const [subscribing, setSubscribing] = useState<"monthly" | "annual" | null>(null);

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
            else alert(d.error || t("genericError"));
        } finally {
            setActing(null);
        }
    };

    const handleCancel = async () => {
        if (!confirm(t("confirmCancel"))) return;
        setActing("cancel");
        try {
            const r = await fetch("/api/billing/cancel", { method: "POST" });
            const d: any = await r.json();
            if (d.success) await load();
            else alert(d.error || t("genericError"));
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
            else alert(d.error || t("genericError"));
        } finally {
            setActing(null);
        }
    };

    const handleSubscribe = async (plan: "monthly" | "annual") => {
        setSubscribing(plan);
        try {
            const r = await fetch("/api/billing/checkout", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ plan, source: "faturacao" }),
            });
            const d: any = await r.json();
            if (d.url) window.location.href = d.url;
            else alert(d.error || t("genericError"));
        } finally {
            setSubscribing(null);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-[400px]">
                <Loader2 className="w-8 h-8 text-accent animate-spin" />
            </div>
        );
    }

    const s = sub?.subscription;
    const uiState = sub?.ui_state;
    const hasSubscription = !!s?.stripe_subscription_id;
    const showSubscribeCta = !hasSubscription && uiState !== "exempt" && uiState !== "trialing_earlybird" && uiState !== "trialing";

    return (
        <div className="max-w-6xl mx-auto space-y-12 animate-in fade-in duration-1000 slide-in-from-bottom-4">
            {stripeResult === "success" && (
                <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-4 px-6 py-4 rounded-2xl bg-[rgba(94,234,212,0.12)] border border-[rgba(94,234,212,0.30)] text-accent-hot">
                    <CheckCheck className="w-5 h-5 shrink-0" />
                    <p className="font-mono text-xs uppercase tracking-[0.18em]">{t("stripeSuccess")}</p>
                </motion.div>
            )}
            <div className="space-y-4">
                <h1 className="text-3xl sm:text-4xl lg:text-5xl font-medium tracking-tight bg-gradient-to-r from-fg via-fg to-fg-40 bg-clip-text text-transparent">
                    {t("title")}
                </h1>
                <p className="text-fg-60 font-medium tracking-wide">
                    {t("subtitle")}
                </p>
            </div>

            {/* Subscription summary card */}
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="glass rounded-[2rem] p-5 sm:p-8">
                <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
                    <div className="flex items-center gap-6">
                        <div className="w-16 h-16 rounded-2xl bg-[rgba(2,141,196,0.15)] ring-1 ring-[rgba(2,141,196,0.30)] flex items-center justify-center">
                            <CreditCard className="w-7 h-7 text-accent" />
                        </div>
                        <div className="space-y-2">
                            <div className="flex items-center gap-3 flex-wrap">
                                <span className={cn(
                                    "px-2 py-0.5 rounded-md font-mono text-[10px] uppercase tracking-[0.22em] border",
                                    uiState === "active" ? "bg-[rgba(94,234,212,0.10)] text-accent-hot border-[rgba(94,234,212,0.20)]" :
                                    uiState === "trialing_earlybird" ? "bg-[rgba(245,158,11,0.10)] text-soon border-[rgba(245,158,11,0.20)]" :
                                    uiState === "trialing" ? "bg-[rgba(2,141,196,0.10)] text-accent border-[rgba(2,141,196,0.20)]" :
                                    uiState === "blocked" ? "bg-[rgba(244,63,94,0.10)] text-destructive border-[rgba(244,63,94,0.20)]" :
                                    "bg-surface-2 text-fg-40 border-hairline"
                                )}>
                                    {uiState === "active" ? t("statusActive") : uiState === "trialing_earlybird" ? t("statusEarlyBird") : uiState === "trialing" ? t("statusTrial") : uiState === "blocked" ? t("statusInactive") : t("statusNone")}
                                </span>
                                {s?.plan && (
                                    <span className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">
                                        {s.plan === "annual" ? t("planAnnual") : t("planMonthly")}
                                    </span>
                                )}
                                {s?.cancel_at_period_end === 1 && (
                                    <span className="px-2 py-0.5 rounded-md font-mono text-[10px] uppercase tracking-[0.22em] border bg-[rgba(244,63,94,0.10)] text-destructive border-[rgba(244,63,94,0.20)]">
                                        {t("cancels", { date: s.current_period_end ? new Date(s.current_period_end).toLocaleDateString("pt-PT") : "" })}
                                    </span>
                                )}
                            </div>
                            <h3 className="text-2xl font-medium tracking-tight">{s?.name || t("subscriptionName")}</h3>
                            {s?.email && <p className="text-sm text-fg-40 font-medium">{s.email}{s.nif && <> · {t("nif")} {s.nif}</>}</p>}
                        </div>
                    </div>

                    {hasSubscription && (
                        <div className="flex flex-wrap gap-3">
                            <button onClick={handleUpdateCard} disabled={!!acting} className="px-5 py-3 rounded-2xl bg-white/5 border border-hairline text-fg font-mono text-[10px] uppercase tracking-[0.18em] hover:bg-white/10 transition-all flex items-center gap-2 disabled:opacity-50">
                                {acting === "update" ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
                                {t("changeCard")}
                            </button>
                            {s?.cancel_at_period_end === 1 ? (
                                <button onClick={handleReactivate} disabled={!!acting} className="px-5 py-3 rounded-2xl bg-[rgba(94,234,212,0.15)] border border-[rgba(94,234,212,0.30)] text-accent-hot font-mono text-[10px] uppercase tracking-[0.18em] hover:bg-[rgba(94,234,212,0.25)] transition-all flex items-center gap-2 disabled:opacity-50">
                                    {acting === "reactivate" ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                                    {t("reactivate")}
                                </button>
                            ) : (
                                <button onClick={handleCancel} disabled={!!acting} className="px-5 py-3 rounded-2xl bg-[rgba(244,63,94,0.10)] border border-[rgba(244,63,94,0.20)] text-destructive font-mono text-[10px] uppercase tracking-[0.18em] hover:bg-[rgba(244,63,94,0.18)] transition-all flex items-center gap-2 disabled:opacity-50">
                                    {acting === "cancel" ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
                                    {t("cancel")}
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </motion.div>

            {/* Subscribe CTA — shown only when user has no active subscription */}
            {showSubscribeCta && (
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
                    <h2 className="font-mono text-[11px] text-fg-40 uppercase tracking-[0.22em]">{t("subscribeHeading")}</h2>
                    <div className="grid sm:grid-cols-2 gap-4">
                        <div className="glass rounded-[2rem] p-6 sm:p-8 flex flex-col gap-6 border border-hairline">
                            <div>
                                <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-fg-40 mb-2">{t("monthlyPlan")}</p>
                                <p className="text-3xl font-medium tracking-tight">{t("monthlyPrice")}</p>
                            </div>
                            <button
                                onClick={() => handleSubscribe("monthly")}
                                disabled={!!subscribing}
                                className="w-full py-4 rounded-2xl font-mono text-[10px] uppercase tracking-[0.18em] bg-white/5 border border-hairline hover:border-rule hover:bg-white/10 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                            >
                                {subscribing === "monthly" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                                {t("btnSubscribeMonthly")}
                            </button>
                        </div>
                        <div className="glass rounded-[2rem] p-6 sm:p-8 flex flex-col gap-6 border border-accent/30 bg-[rgba(2,141,196,0.04)]">
                            <div>
                                <div className="flex items-center gap-2 mb-2">
                                    <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-fg-40">{t("annualPlan")}</p>
                                    <span className="px-2 py-0.5 rounded-md font-mono text-[9px] uppercase tracking-[0.18em] bg-[rgba(94,234,212,0.15)] text-accent-hot border border-[rgba(94,234,212,0.25)]">{t("annualSaving")}</span>
                                </div>
                                <p className="text-3xl font-medium tracking-tight">{t("annualPrice")}</p>
                            </div>
                            <button
                                onClick={() => handleSubscribe("annual")}
                                disabled={!!subscribing}
                                className="w-full py-4 rounded-2xl font-mono text-[10px] uppercase tracking-[0.18em] bg-accent text-surface font-bold hover:bg-accent-hot transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                            >
                                {subscribing === "annual" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                                {t("btnSubscribeAnnual")}
                            </button>
                        </div>
                    </div>
                </motion.div>
            )}

            {/* Events table */}
            <section className="space-y-4">
                <div className="flex items-center gap-3">
                    <Receipt className="w-5 h-5 text-fg-40" />
                    <h2 className="font-mono text-[11px] text-fg-40 uppercase tracking-[0.22em]">{t("historyHeading")}</h2>
                </div>

                {events.length === 0 ? (
                    <div className="glass rounded-[2rem] p-8 sm:p-16 text-center">
                        <Receipt className="w-12 h-12 text-fg-40 mx-auto mb-4" />
                        <p className="text-fg-40 font-medium text-sm">{t("emptyHistory")}</p>
                    </div>
                ) : (
                    <div className="glass rounded-[2rem] overflow-x-auto">
                        <table className="w-full min-w-[640px]">
                            <thead className="bg-surface-2/50 border-b border-hairline">
                                <tr>
                                    <th className="text-left px-6 py-4 font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">{t("colDate")}</th>
                                    <th className="text-left px-6 py-4 font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">{t("colRef")}</th>
                                    <th className="text-right px-6 py-4 font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">{t("colAmount")}</th>
                                    <th className="text-left px-6 py-4 font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">{t("colStatus")}</th>
                                    <th className="text-left px-6 py-4 font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">{t("colIxInvoice")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {events.map((e) => {
                                    const isRefund = e.type === "charge.refunded";
                                    return (
                                        <tr key={e.id} className={cn("border-b border-hairline hover:bg-white/[0.02] transition-colors", isRefund && "bg-[rgba(244,63,94,0.05)]")}>
                                            <td className="px-6 py-4 text-sm text-fg font-medium">{formatDate(e.created_at)}</td>
                                            <td className="px-6 py-4 text-xs text-fg-60 font-mono">{formatRef(e.payment_intent_id, e.stripe_object_id)}</td>
                                            <td className={cn("px-6 py-4 text-sm font-medium text-right tabular-nums", isRefund ? "text-destructive" : "text-fg")}>
                                                {isRefund ? "-" : ""}{formatAmount(e.amount_cents, e.currency)}
                                            </td>
                                            <td className="px-6 py-4"><StatusBadge status={e.status} type={e.type} t={t} /></td>
                                            <td className="px-6 py-4">
                                                {e.ix_invoice_permalink ? (
                                                    <a href={e.ix_invoice_permalink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-xs font-medium text-accent hover:text-accent-hot transition-colors">
                                                        {isRefund ? t("viewCreditNote") : t("viewInvoice")}
                                                        <ExternalLink className="w-3 h-3" />
                                                        {e.ix_match_method === "heuristic" && (
                                                            <span className="font-mono text-[10px] text-soon uppercase tracking-[0.22em]" title={t("heuristicTooltip", { score: e.ix_match_score ?? "" })}>~</span>
                                                        )}
                                                    </a>
                                                ) : (
                                                    <span className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">{t("processing")}</span>
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
