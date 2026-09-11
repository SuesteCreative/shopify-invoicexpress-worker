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
    connection_key?: string;
    enforced?: boolean;
    connections?: { key: string; source: string | null; ui_state: UIState; blocked: boolean }[];
}

type Money = { amount_cents: number; currency: string };

function daysUntil(iso?: string | null): number | null {
    if (!iso) return null;
    const diff = new Date(iso).getTime() - Date.now();
    return Math.max(0, Math.ceil(diff / 86400000));
}

/**
 * `connectionKey` names which connection this card is about — an account can
 * hold a subscription per connection since migration 0044, and a card on the
 * Stripe page must not report the Shopify shop's. Omitted (the dashboard), the
 * API answers for the account's oldest connection.
 */
export default function SubscriptionCard(
    { onSuccess, source, connectionKey }: { onSuccess?: boolean; source?: string; connectionKey?: string },
) {
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
    // What this account is actually charged. Asked of the server, which reads the
    // same Stripe price the button will charge: the figures used to be written
    // into the markup, and were only ever true of the original product.
    const [prices, setPrices] = useState<{ monthly: Money | null; annual: Money | null } | null>(null);

    const refresh = async () => {
        try {
            const res = await fetch(
                connectionKey
                    ? `/api/billing/subscription?connection_key=${encodeURIComponent(connectionKey)}`
                    : "/api/billing/subscription",
            );
            const d = await res.json() as SubData;
            setData(d);
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { refresh(); }, [connectionKey]);

    useEffect(() => {
        let alive = true;
        fetch(`/api/billing/price?source=${encodeURIComponent(source ?? "faturacao")}`)
            .then(r => (r.ok ? r.json() : null))
            .then((d: any) => { if (alive && d) setPrices({ monthly: d.monthly ?? null, annual: d.annual ?? null }); })
            .catch(() => { /* the plate simply shows no figure */ });
        return () => { alive = false; };
    }, [source]);

    const money = (m: Money | null | undefined) =>
        m ? new Intl.NumberFormat(dateLocale || "pt-PT", {
            style: "currency", currency: (m.currency || "eur").toUpperCase(),
            minimumFractionDigits: m.amount_cents % 100 === 0 ? 0 : 2,
        }).format(m.amount_cents / 100) : null;

    /** "equivale a X/mês", from the yearly price rather than from a fixed sentence. */
    const monthlyEquivalent = prices?.annual
        ? money({ amount_cents: Math.round(prices.annual.amount_cents / 12), currency: prices.annual.currency })
        : null;

    /** Only claimed when the year really is cheaper than twelve months of it. */
    const savedPercent = prices?.annual && prices?.monthly && prices.monthly.amount_cents > 0
        ? (() => {
            const pct = Math.round((1 - prices.annual!.amount_cents / (prices.monthly!.amount_cents * 12)) * 100);
            return pct >= 1 ? pct : null;
        })()
        : null;

    const startCheckout = async () => {
        setActing(true);
        // Open the tab synchronously inside the click handler so it counts as a
        // user gesture — otherwise popup blockers kill window.open after the await.
        const checkoutTab = window.open("", "_blank");
        try {
            const res = await fetch("/api/billing/checkout", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    plan: selectedPlan,
                    source: source ?? "faturacao",
                    ...(connectionKey ? { connection_key: connectionKey } : {}),
                }),
            });
            const d = (await res.json()) as { url?: string; error?: string };
            if (d.url) {
                if (checkoutTab) {
                    checkoutTab.location.href = d.url;
                } else {
                    // Popup was blocked — fall back to same-tab redirect.
                    window.location.href = d.url;
                }
                setActing(false);
            } else {
                checkoutTab?.close();
                alert(d.error || t("errorCheckout"));
                setActing(false);
            }
        } catch (e: any) {
            checkoutTab?.close();
            alert(e.message);
            setActing(false);
        }
    };

    if (loading) {
        return (
            <div className="glass rounded-[2rem] p-5 sm:p-8 flex items-center justify-center min-h-[180px]">
                <Loader2 className="w-6 h-6 text-accent-ink animate-spin" />
            </div>
        );
    }

    const state = data?.ui_state ?? "none";
    const sub = data?.subscription;

    if (state === "exempt") {
        return (
            <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
                className="glass rounded-[2rem] border-2 border-destructive/30 bg-destructive/4 p-6 flex items-center gap-5">
                <div className="w-12 h-12 rounded-2xl bg-destructive/15 ring-1 ring-destructive/30 flex items-center justify-center shrink-0">
                    <ShieldCheck className="w-6 h-6 text-destructive" />
                </div>
                <div>
                    <span className="px-2 py-0.5 rounded-md font-mono text-[9px] uppercase tracking-[0.22em] border bg-destructive/10 text-destructive border-destructive/20">
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
            ring: "border-accent-hot/40 bg-accent-hot/4",
            iconBg: "bg-accent-hot/15 text-accent-hot ring-accent-hot/30",
            badge: "bg-accent-hot/10 text-accent-hot border-accent-hot/20",
            badgeText: t("badgeActive"),
            title: t("titleActive"),
            icon: Check,
        },
        trialing_earlybird: {
            ring: "border-soon/40 bg-soon/4",
            iconBg: "bg-soon/15 text-soon ring-soon/30",
            badge: "bg-soon/10 text-soon border-soon/20",
            badgeText: t("badgeEarlyBird"),
            title: t("titleEarlyBird"),
            icon: Sparkles,
        },
        trialing: {
            ring: "border-accent/40 bg-accent/4",
            iconBg: "bg-accent/15 text-accent-ink ring-accent/30",
            badge: "bg-accent/10 text-accent-ink border-accent/20",
            badgeText: t("badgeTrial"),
            title: t("titleTrial"),
            icon: Clock,
        },
        blocked: {
            ring: "border-destructive/40 bg-destructive/5",
            iconBg: "bg-destructive/15 text-destructive ring-destructive/30",
            badge: "bg-destructive/15 text-destructive border-destructive/30",
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
                <motion.div initial={{ y: -40 }} animate={{ y: 0 }} className="absolute top-0 left-0 right-0 bg-accent-hot/18 text-accent-hot text-center py-2 font-mono text-xs uppercase tracking-[0.22em]">
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
                                <span className="px-2 py-0.5 rounded-md font-mono text-[9px] uppercase tracking-[0.22em] border bg-destructive/10 text-destructive border-destructive/20">
                                    {t("cancels", { date: formatDate(sub.current_period_end) })}
                                </span>
                            )}
                        </div>
                        <h3 className="text-2xl font-medium tracking-tight text-fg">{config.title}</h3>
                        <p className="text-sm text-fg-60 font-medium leading-relaxed max-w-2xl">
                            {state === "active" && sub?.current_period_end && t("bodyActive", { date: formatDate(sub.current_period_end) })}
                            {state === "trialing_earlybird" && (sub?.trial_end
                                ? t("bodyEarlyBird", { date: formatDate(sub.trial_end), days: daysLeft ?? 0 })
                                : t("bodyEarlyBirdNoDate"))}
                            {state === "trialing" && sub?.trial_end && t("bodyTrial", { date: formatDate(sub.trial_end), days: daysLeft ?? 0 })}
                            {state === "blocked" && t("bodyBlocked")}
                            {state === "none" && t("bodyNone")}
                        </p>
                    </div>

                    {state === "active" && (
                        <Link
                            href="/faturacao"
                            className="px-6 py-3 rounded-2xl bg-veil border border-hairline text-fg font-mono text-xs uppercase tracking-[0.18em] hover:bg-fg/10 transition-all flex items-center gap-3 shrink-0"
                        >
                            {t("manageBilling")} <ArrowRight className="w-4 h-4" />
                        </Link>
                    )}
                </div>

                {showCheckout && (
                    <div className="flex flex-col lg:flex-row gap-6 items-stretch">
                        {/* min-w-0 so the two plates can shrink instead of pushing
                            their own price past the card's edge. */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 flex-1 min-w-0">
                            <button
                                onClick={() => setSelectedPlan("monthly")}
                                className={cn(
                                    "relative rounded-2xl border-2 p-5 sm:p-6 text-left transition-all transform active:scale-[0.98] min-w-0",
                                    selectedPlan === "monthly"
                                        ? "border-fg bg-fg/[0.07] shadow-xl"
                                        : "border-hairline bg-surface-2/30 hover:border-rule"
                                )}
                            >
                                {/* pr-8 keeps the label clear of the tick in the corner. */}
                                <div className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em] mb-2 pr-8">{t("tabMonthly")}</div>
                                <div className="flex items-baseline gap-1 flex-wrap">
                                    <span className="text-3xl sm:text-4xl font-medium text-fg tabular-nums">{money(prices?.monthly) ?? "—"}</span>
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
                                    "relative rounded-2xl border-2 p-5 sm:p-6 text-left transition-all transform active:scale-[0.98] min-w-0",
                                    selectedPlan === "annual"
                                        ? "border-accent-hot bg-accent-hot/8"
                                        : "border-hairline bg-surface-2/30 hover:border-rule"
                                )}
                            >
                                {/* The badge wraps under the label on a narrow plate
                                    instead of sliding under the tick in the corner. */}
                                <div className="flex items-center gap-2 mb-2 pr-8 flex-wrap">
                                    <span className="font-mono text-[10px] text-accent-hot uppercase tracking-[0.22em]">{t("tabAnnual")}</span>
                                    {savedPercent !== null && (
                                        <span className="font-mono text-[9px] px-1.5 py-0.5 rounded bg-accent-hot/18 text-accent-hot uppercase tracking-[0.22em] whitespace-nowrap">{t("savePercent", { pct: savedPercent })}</span>
                                    )}
                                </div>
                                <div className="flex items-baseline gap-1 flex-wrap">
                                    <span className="text-3xl sm:text-4xl font-medium text-fg tabular-nums">{money(prices?.annual) ?? "—"}</span>
                                    <span className="text-sm text-fg-40 font-medium">{t("perYear")}</span>
                                </div>
                                <div className="text-[11px] text-fg-40 font-medium mt-2">
                                    {monthlyEquivalent ? t("vatAnnualEquivalent", { amount: monthlyEquivalent }) : t("vatAnnualPlain")}
                                </div>
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
                                // self-center, or the row's stretch makes the button
                                // as tall as the two plates beside it — which day
                                // mode then rounds into a black ellipse.
                                "px-6 py-3.5 rounded-2xl font-mono text-xs uppercase tracking-[0.18em] transition-all transform active:scale-95 flex items-center justify-center gap-2.5 w-full lg:w-auto lg:min-w-[190px] lg:shrink-0 lg:self-center",
                                state === "blocked"
                                    ? "bg-destructive text-on-accent hover:bg-destructive/85"
                                    : state === "trialing_earlybird"
                                        ? "bg-soon text-surface hover:bg-soon/85"
                                        : "bg-fg text-surface hover:bg-accent-hot shadow-[0_8px_30px_-12px_color-mix(in_srgb,var(--accent)_45%,transparent)]",
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
