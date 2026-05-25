"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { CreditCard, Check, AlertTriangle, Clock, Sparkles, ArrowRight, Loader2, ShieldCheck } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
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

function daysUntil(iso?: string | null): number | null {
    if (!iso) return null;
    const diff = new Date(iso).getTime() - Date.now();
    return Math.max(0, Math.ceil(diff / 86400000));
}

export default function SubscriptionCard({ onSuccess }: { onSuccess?: boolean }) {
    const t = useTranslations("subscriptionCard");
    const dateLocale = t("dateLocale");
    const formatDate = (iso?: string | null): string => {
        if (!iso) return "";
        try {
            return new Date(iso).toLocaleDateString(dateLocale, { day: "2-digit", month: "2-digit", year: "numeric" });
        } catch { return ""; }
    };

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
                alert(d.error || t("errorCheckout"));
                setActing(false);
            }
        } catch (e: any) {
            alert(e.message);
            setActing(false);
        }
    };

    if (loading) {
        return (
            <div className="glass rounded-[2rem] p-5 sm:p-8 flex items-center justify-center min-h-[180px]">
                <Loader2 className="w-6 h-6 text-accent animate-spin" />
            </div>
        );
    }

    const state = data?.ui_state ?? "none";
    const sub = data?.subscription;

    if (state === "exempt") {
        return (
            <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
                className="glass rounded-[2rem] border-2 border-[rgba(244,63,94,0.30)] bg-[rgba(244,63,94,0.04)] p-6 flex items-center gap-5">
                <div className="w-12 h-12 rounded-2xl bg-[rgba(244,63,94,0.15)] ring-1 ring-[rgba(244,63,94,0.30)] flex items-center justify-center shrink-0">
                    <ShieldCheck className="w-6 h-6 text-destructive" />
                </div>
                <div>
                    <span className="px-2 py-0.5 rounded-md font-mono text-[9px] uppercase tracking-[0.22em] border bg-[rgba(244,63,94,0.10)] text-destructive border-[rgba(244,63,94,0.20)]">
                        {t("admin")}
                    </span>
                    <h3 className="text-lg font-medium tracking-tight text-fg mt-1">{t("exemptTitle")}</h3>
                    <p className="text-xs text-fg-60 font-medium">{t("exemptBody")}</p>
                </div>
            </motion.div>
        );
    }

    const config = {
        active: {
            ring: "border-[rgba(94,234,212,0.40)] bg-[rgba(94,234,212,0.04)]",
            iconBg: "bg-[rgba(94,234,212,0.15)] text-accent-hot ring-[rgba(94,234,212,0.30)]",
            badge: "bg-[rgba(94,234,212,0.10)] text-accent-hot border-[rgba(94,234,212,0.20)]",
            badgeText: t("badgeActive"),
            title: t("titleActive"),
            icon: Check,
        },
        trialing_earlybird: {
            ring: "border-[rgba(245,158,11,0.40)] bg-[rgba(245,158,11,0.04)]",
            iconBg: "bg-[rgba(245,158,11,0.15)] text-soon ring-[rgba(245,158,11,0.30)]",
            badge: "bg-[rgba(245,158,11,0.10)] text-soon border-[rgba(245,158,11,0.20)]",
            badgeText: t("badgeEarlyBird"),
            title: t("titleEarlyBird"),
            icon: Sparkles,
        },
        trialing: {
            ring: "border-[rgba(2,141,196,0.40)] bg-[rgba(2,141,196,0.04)]",
            iconBg: "bg-[rgba(2,141,196,0.15)] text-accent ring-[rgba(2,141,196,0.30)]",
            badge: "bg-[rgba(2,141,196,0.10)] text-accent border-[rgba(2,141,196,0.20)]",
            badgeText: t("badgeTrial"),
            title: t("titleTrial"),
            icon: Clock,
        },
        blocked: {
            ring: "border-[rgba(244,63,94,0.40)] bg-[rgba(244,63,94,0.05)]",
            iconBg: "bg-[rgba(244,63,94,0.15)] text-destructive ring-[rgba(244,63,94,0.30)]",
            badge: "bg-[rgba(244,63,94,0.15)] text-destructive border-[rgba(244,63,94,0.30)]",
            badgeText: t("badgeBlocked"),
            title: t("titleBlocked"),
            icon: AlertTriangle,
        },
        none: {
            ring: "border-hairline",
            iconBg: "bg-surface-2 text-fg-60 ring-hairline",
            badge: "bg-surface-2 text-fg-60 border-hairline",
            badgeText: t("badgeNone"),
            title: t("titleNone"),
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
            className={cn("glass rounded-[2rem] border-2 p-5 sm:p-8 relative overflow-hidden", config.ring)}
        >
            {onSuccess && (
                <motion.div initial={{ y: -40 }} animate={{ y: 0 }} className="absolute top-0 left-0 right-0 bg-[rgba(94,234,212,0.18)] text-accent-hot text-center py-2 font-mono text-xs uppercase tracking-[0.22em]">
                    {t("success")}
                </motion.div>
            )}

            <div className="flex flex-col gap-8">
                <div className="flex flex-col lg:flex-row items-start lg:items-center gap-6">
                    <div className={cn("w-16 h-16 rounded-2xl flex items-center justify-center ring-1 shrink-0", config.iconBg)}>
                        <Icon className="w-7 h-7 stroke-[2]" />
                    </div>

                    <div className="flex-1 space-y-2">
                        <div className="flex items-center gap-3 flex-wrap">
                            <span className={cn("px-2 py-0.5 rounded-md font-mono text-[9px] uppercase tracking-[0.22em] border", config.badge)}>
                                {config.badgeText}
                            </span>
                            {sub?.plan && (
                                <span className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">
                                    {sub.plan === "annual" ? t("planAnnual") : t("planMonthly")}
                                </span>
                            )}
                            {sub?.cancel_at_period_end === 1 && (
                                <span className="px-2 py-0.5 rounded-md font-mono text-[9px] uppercase tracking-[0.22em] border bg-[rgba(244,63,94,0.10)] text-destructive border-[rgba(244,63,94,0.20)]">
                                    {t("cancels", { date: formatDate(sub.current_period_end) })}
                                </span>
                            )}
                        </div>
                        <h3 className="text-2xl font-medium tracking-tight text-fg">{config.title}</h3>
                        <p className="text-sm text-fg-60 font-medium leading-relaxed max-w-2xl">
                            {state === "active" && sub?.current_period_end && t("bodyActive", { date: formatDate(sub.current_period_end) })}
                            {state === "trialing_earlybird" && t("bodyEarlyBird", { days: daysLeft ?? 0 })}
                            {state === "trialing" && sub?.trial_end && t("bodyTrial", { date: formatDate(sub.trial_end), days: daysLeft ?? 0 })}
                            {state === "blocked" && t("bodyBlocked")}
                            {state === "none" && t("bodyNone")}
                        </p>
                    </div>

                    {state === "active" && (
                        <Link
                            href="/faturacao"
                            className="px-6 py-3 rounded-2xl bg-white/5 border border-hairline text-fg font-mono text-xs uppercase tracking-[0.18em] hover:bg-white/10 transition-all flex items-center gap-3 shrink-0"
                        >
                            {t("manageBilling")} <ArrowRight className="w-4 h-4" />
                        </Link>
                    )}
                </div>

                {showCheckout && (
                    <div className="flex flex-col lg:flex-row gap-6 items-stretch">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 flex-1">
                            <button
                                onClick={() => setSelectedPlan("monthly")}
                                className={cn(
                                    "relative rounded-2xl border-2 p-6 text-left transition-all transform active:scale-[0.98]",
                                    selectedPlan === "monthly"
                                        ? "border-fg bg-white/[0.07] shadow-xl"
                                        : "border-hairline bg-surface-2/30 hover:border-rule"
                                )}
                            >
                                <div className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em] mb-2">{t("tabMonthly")}</div>
                                <div className="flex items-baseline gap-1">
                                    <span className="text-4xl font-medium text-fg tabular-nums">7,50€</span>
                                    <span className="text-sm text-fg-40 font-medium">{t("perMonth")}</span>
                                </div>
                                <div className="text-[11px] text-fg-40 font-medium mt-2">{t("vatMonthly")}</div>
                                {selectedPlan === "monthly" && (
                                    <div className="absolute top-3 right-3 w-5 h-5 rounded-full bg-fg flex items-center justify-center">
                                        <Check className="w-3 h-3 text-surface stroke-[3]" />
                                    </div>
                                )}
                            </button>

                            <button
                                onClick={() => setSelectedPlan("annual")}
                                className={cn(
                                    "relative rounded-2xl border-2 p-6 text-left transition-all transform active:scale-[0.98]",
                                    selectedPlan === "annual"
                                        ? "border-accent-hot bg-[rgba(94,234,212,0.08)]"
                                        : "border-hairline bg-surface-2/30 hover:border-rule"
                                )}
                            >
                                <div className="flex items-center gap-2 mb-2">
                                    <span className="font-mono text-[10px] text-accent-hot uppercase tracking-[0.22em]">{t("tabAnnual")}</span>
                                    <span className="font-mono text-[9px] px-1.5 py-0.5 rounded bg-[rgba(94,234,212,0.18)] text-accent-hot uppercase tracking-[0.22em]">{t("save17")}</span>
                                </div>
                                <div className="flex items-baseline gap-1">
                                    <span className="text-4xl font-medium text-fg tabular-nums">75€</span>
                                    <span className="text-sm text-fg-40 font-medium">{t("perYear")}</span>
                                </div>
                                <div className="text-[11px] text-fg-40 font-medium mt-2">{t("vatAnnual")}</div>
                                {selectedPlan === "annual" && (
                                    <div className="absolute top-3 right-3 w-5 h-5 rounded-full bg-accent-hot flex items-center justify-center">
                                        <Check className="w-3 h-3 text-surface stroke-[3]" />
                                    </div>
                                )}
                            </button>
                        </div>

                        <button
                            disabled={acting}
                            onClick={startCheckout}
                            className={cn(
                                "px-5 sm:px-8 py-4 rounded-2xl font-mono text-sm uppercase tracking-[0.18em] transition-all transform active:scale-95 flex items-center justify-center gap-3 w-full lg:w-auto lg:min-w-[260px] lg:shrink-0",
                                state === "blocked"
                                    ? "bg-destructive text-white hover:bg-destructive/85"
                                    : state === "trialing_earlybird"
                                        ? "bg-soon text-surface hover:bg-soon/85"
                                        : "bg-fg text-surface hover:bg-accent-hot shadow-[0_8px_30px_-12px_rgba(2,141,196,0.45)]",
                                acting && "opacity-50 cursor-not-allowed"
                            )}
                        >
                            {acting && <Loader2 className="w-4 h-4 animate-spin" />}
                            {!acting && state === "blocked" && t("ctaReactivate")}
                            {!acting && state === "trialing_earlybird" && t("ctaAddPayment")}
                            {!acting && state === "none" && t("ctaSubscribe")}
                            {!acting && state === "trialing" && t("ctaUpgrade")}
                            {!acting && <ArrowRight className="w-4 h-4" />}
                        </button>
                    </div>
                )}
            </div>
        </motion.div>
    );
}
