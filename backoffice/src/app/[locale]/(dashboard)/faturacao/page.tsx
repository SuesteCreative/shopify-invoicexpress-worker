"use client";

export const runtime = "edge";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { Receipt, ExternalLink, Loader2, CreditCard, AlertCircle, CheckCircle2, XCircle, Clock, RefreshCw, CheckCheck, Zap, Gift } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import SuspendedBanner from "@/components/SuspendedBanner";
import { ReferralCard } from "@/components/ReferralCard";
import { rewardRunning } from "@/lib/subscription-state";
import { canHaveKaptaDocument } from "@/lib/billing-document";

import { cn } from "@/lib/utils";

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

type Money = { amount_cents: number; currency: string };

/** Intl locale for the locale the merchant is reading the dashboard in.
 *  en-GB, not en-US, so the day still comes first. */
const intlLocaleFor = (locale: string) => (locale === "en" ? "en-GB" : "pt-PT");

function formatAmount(cents: number, currency: string, intlLocale: string): string {
    return new Intl.NumberFormat(intlLocale, { style: "currency", currency: (currency || "eur").toUpperCase() }).format(cents / 100);
}

function formatDate(iso: string, intlLocale: string): string {
    return new Date(iso).toLocaleString(intlLocale, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatRef(pi: string | null, invId: string): string {
    if (pi) return `#stripe ${pi}`;
    return `#stripe ${invId}`;
}

function StatusBadge({ status, type, t }: { status: string; type: string; t: (k: string) => string }) {
    if (type === "charge.refunded") {
        return (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md font-mono text-[10px] uppercase tracking-[0.18em] border bg-destructive/10 text-destructive border-destructive/20">
                <RefreshCw className="w-3 h-3" />
                {t("badgeRefund")}
            </span>
        );
    }
    const config: Record<string, { bg: string; labelKey: string; icon: any }> = {
        paid: { bg: "bg-accent-hot/10 text-accent-hot border-accent-hot/20", labelKey: "badgePaid", icon: CheckCircle2 },
        failed: { bg: "bg-destructive/10 text-destructive border-destructive/20", labelKey: "badgeFailed", icon: XCircle },
        open: { bg: "bg-soon/10 text-soon border-soon/20", labelKey: "badgeOpen", icon: Clock },
        void: { bg: "bg-surface-2 text-fg-40 border-hairline", labelKey: "badgeVoid", icon: XCircle },
        uncollectible: { bg: "bg-destructive/10 text-destructive border-destructive/20", labelKey: "badgeUncollectible", icon: AlertCircle },
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
    const tCard = useTranslations("subscriptionCard");
    const intlLocale = intlLocaleFor(useLocale());
    const searchParams = useSearchParams();
    const stripeResult = searchParams.get("stripe");
    const [sub, setSub] = useState<any>(null);
    const [events, setEvents] = useState<BillingEvent[]>([]);
    const [loading, setLoading] = useState(true);
    const [acting, setActing] = useState<string | null>(null);
    const [subscribing, setSubscribing] = useState<"monthly" | "annual" | null>(null);
    const [linkSubId, setLinkSubId] = useState("");
    // What the plates below charge. handleSubscribe sends "faturacao", which the
    // checkout prices from the account's primary connection; the figures used to
    // be fixed strings in the messages, true only of the Shopify pair.
    const [prices, setPrices] = useState<{ monthly: Money | null; annual: Money | null } | null>(null);

    useEffect(() => {
        let alive = true;
        fetch("/api/billing/price?source=faturacao")
            .then(r => (r.ok ? r.json() : null))
            .then((d: any) => { if (alive && d) setPrices({ monthly: d.monthly ?? null, annual: d.annual ?? null }); })
            .catch(() => { /* the plates simply show no figure */ });
        return () => { alive = false; };
    }, []);

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

    const handleManageSubscription = async () => {
        setActing("portal");
        try {
            const r = await fetch("/api/billing/portal", { method: "POST" });
            const d: any = await r.json();
            if (d.url) window.location.href = d.url;
            else alert(d.error || t("genericError"));
        } finally {
            setActing(null);
        }
    };

    const handleLinkSubscription = async () => {
        const subId = linkSubId.trim();
        if (!subId) return;
        setActing("link");
        try {
            const r = await fetch("/api/admin/link-subscription", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ user_id: sub?.user_id, subscription_id: subId }),
            });
            const d: any = await r.json();
            if (d.ok) {
                setLinkSubId("");
                alert(t("linkSubOk"));
                await load();
            } else {
                alert(d.error || t("linkSubError"));
            }
        } catch (e: any) {
            alert(e?.message || t("linkSubError"));
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
            else {
                alert(d.error || t("genericError"));
                // A subscription landed since the page loaded: show it instead.
                if (d.code === "already_subscribed") await load();
            }
        } finally {
            setSubscribing(null);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-[400px]">
                <Loader2 className="w-8 h-8 text-accent-ink animate-spin" />
            </div>
        );
    }

    const s = sub?.subscription;
    const uiState = sub?.ui_state;
    const hasSubscription = !!s?.stripe_subscription_id;
    // Two campaign months ride on a Stripe trial. The state stays "trialing", so
    // the page keeps behaving as for any paying trial; only the words change.
    const reward = rewardRunning(s);
    // Show the payment cards while blocked/none AND during the early-bird grace,
    // so a Shopify pilot can subscribe any time before their grace ends (per-client
    // date). "trialing" (a paying Stripe trial) keeps a sub, so it's excluded.
    const showSubscribeCta = !hasSubscription && uiState !== "exempt" && uiState !== "trialing";

    // Formatted as SubscriptionCard formats the same answer, with its words.
    const money = (m: Money | null | undefined) =>
        m ? new Intl.NumberFormat(intlLocale, {
            style: "currency", currency: (m.currency || "eur").toUpperCase(),
            minimumFractionDigits: m.amount_cents % 100 === 0 ? 0 : 2,
        }).format(m.amount_cents / 100) : null;
    /** Only claimed when the year really is cheaper than twelve months of it. */
    const savedPercent = prices?.annual && prices?.monthly && prices.monthly.amount_cents > 0
        ? (() => {
            const pct = Math.round((1 - prices.annual!.amount_cents / (prices.monthly!.amount_cents * 12)) * 100);
            return pct >= 1 ? pct : null;
        })()
        : null;

    return (
        <div className="max-w-6xl mx-auto space-y-12 animate-in fade-in duration-1000 slide-in-from-bottom-4">
            {stripeResult === "success" && (
                <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-4 px-6 py-4 rounded-2xl bg-accent-hot/12 border border-accent-hot/30 text-accent-hot">
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
                        <div className="w-16 h-16 rounded-2xl bg-accent/15 ring-1 ring-accent/30 flex items-center justify-center">
                            <CreditCard className="w-7 h-7 text-accent-ink" />
                        </div>
                        <div className="space-y-2">
                            <div className="flex items-center gap-3 flex-wrap">
                                <span className={cn(
                                    "px-2 py-0.5 rounded-md font-mono text-[10px] uppercase tracking-[0.22em] border",
                                    uiState === "active" ? "bg-accent-hot/10 text-accent-hot border-accent-hot/20" :
                                    uiState === "trialing_earlybird" ? "bg-soon/10 text-soon border-soon/20" :
                                    uiState === "trialing" ? "bg-accent/10 text-accent-ink border-accent/20" :
                                    uiState === "blocked" ? "bg-destructive/10 text-destructive border-destructive/20" :
                                    "bg-surface-2 text-fg-40 border-hairline"
                                )}>
                                    {uiState === "active" ? t("statusActive") : uiState === "trialing_earlybird" ? t("statusEarlyBird") : uiState === "trialing" ? (reward ? t("statusReward") : t("statusTrial")) : uiState === "blocked" ? t("statusInactive") : t("statusNone")}
                                </span>
                                {/* Only what this subscription really bills. The fallback here
                                    stated 7,50 €/75 €, which is wrong for everyone on the old
                                    5 €/50 € — and the fallback ran precisely when Stripe could
                                    not be read, so nobody could tell it apart from the truth.
                                    No label beats a wrong one; the amount is on the invoice. */}
                                {s?.plan && sub?.plan_price && (
                                    <span className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">
                                        {t(sub.plan_price.interval === "year" ? "planDynamicAnnual" : "planDynamicMonthly", { amount: (sub.plan_price.amount_cents / 100).toFixed(2) })}
                                    </span>
                                )}
                                {s?.cancel_at_period_end === 1 && (
                                    <span className="px-2 py-0.5 rounded-md font-mono text-[10px] uppercase tracking-[0.22em] border bg-destructive/10 text-destructive border-destructive/20">
                                        {t("cancels", { date: s.current_period_end ? new Date(s.current_period_end).toLocaleDateString(intlLocale) : "" })}
                                    </span>
                                )}
                            </div>
                            <h3 className="text-2xl font-medium tracking-tight">{s?.name || t("subscriptionName")}</h3>
                            {s?.email && <p className="text-sm text-fg-40 font-medium">{s.email}{s.nif && <> · {t("nif")} {s.nif}</>}</p>}
                            {hasSubscription && (
                                <div className="flex flex-wrap gap-x-6 gap-y-1 pt-1 text-[11px] text-fg-40 font-mono">
                                    {s?.current_period_end && (
                                        <span>{t("nextCharge")}: <span className="text-fg-60">{new Date(s.current_period_end).toLocaleDateString(intlLocale)}</span></span>
                                    )}
                                    {s?.stripe_subscription_id && (
                                        <span>{t("subLabel")}: <span className="text-fg-60 break-all">{s.stripe_subscription_id}</span></span>
                                    )}
                                    {s?.stripe_customer_id && (
                                        <span>{t("customerLabel")}: <span className="text-fg-60 break-all">{s.stripe_customer_id}</span></span>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    {hasSubscription && (
                        <div className="flex flex-wrap gap-3">
                            <button onClick={handleManageSubscription} disabled={!!acting} className="px-5 py-3 rounded-2xl bg-accent/15 border border-accent/30 text-accent-ink font-mono text-[10px] uppercase tracking-[0.18em] hover:bg-accent/25 transition-all flex items-center gap-2 disabled:opacity-50">
                                {acting === "portal" ? <Loader2 className="w-4 h-4 animate-spin" /> : <ExternalLink className="w-4 h-4" />}
                                {t("manageSubscription")}
                            </button>
                            <button onClick={handleUpdateCard} disabled={!!acting} className="px-5 py-3 rounded-2xl bg-veil border border-hairline text-fg font-mono text-[10px] uppercase tracking-[0.18em] hover:bg-fg/10 transition-all flex items-center gap-2 disabled:opacity-50">
                                {acting === "update" ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
                                {t("changeCard")}
                            </button>
                            {s?.cancel_at_period_end === 1 ? (
                                <button onClick={handleReactivate} disabled={!!acting} className="px-5 py-3 rounded-2xl bg-accent-hot/15 border border-accent-hot/30 text-accent-hot font-mono text-[10px] uppercase tracking-[0.18em] hover:bg-accent-hot/25 transition-all flex items-center gap-2 disabled:opacity-50">
                                    {acting === "reactivate" ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                                    {t("reactivate")}
                                </button>
                            ) : (
                                <button onClick={handleCancel} disabled={!!acting} className="px-5 py-3 rounded-2xl bg-destructive/10 border border-destructive/20 text-destructive font-mono text-[10px] uppercase tracking-[0.18em] hover:bg-destructive/18 transition-all flex items-center gap-2 disabled:opacity-50">
                                    {acting === "cancel" ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
                                    {t("cancel")}
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </motion.div>

            {/* Admin-only: manually associate a Stripe subscription (e.g. from a Payment Link) */}
            {sub?.viewer_is_admin && (
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="glass rounded-[2rem] p-5 sm:p-8 border border-soon/20">
                    <div className="flex items-center gap-2 mb-2">
                        <span className="font-mono text-[11px] text-soon uppercase tracking-[0.22em]">{t("linkSubTitle")}</span>
                    </div>
                    <p className="text-[11px] text-fg-40 mb-4">{t("linkSubHint")}</p>
                    <div className="flex flex-col sm:flex-row gap-3">
                        <input
                            value={linkSubId}
                            onChange={(e) => setLinkSubId(e.target.value)}
                            placeholder={t("linkSubPlaceholder")}
                            className="flex-1 bg-surface-2/50 border border-hairline rounded-2xl px-5 py-3 text-sm font-mono focus:ring-2 focus:ring-soon/20 focus:border-soon outline-none transition-all placeholder:text-fg-40"
                        />
                        <button onClick={handleLinkSubscription} disabled={!!acting || !linkSubId.trim()} className="px-6 py-3 rounded-2xl bg-soon/15 border border-soon/30 text-soon font-mono text-[10px] uppercase tracking-[0.18em] hover:bg-soon/25 transition-all flex items-center justify-center gap-2 disabled:opacity-50">
                            {acting === "link" ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                            {t("linkSubButton")}
                        </button>
                    </div>
                </motion.div>
            )}

            {/* Subscribe CTA — shown while blocked/none and during early-bird grace */}
            {showSubscribeCta && (
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
                    {uiState === "trialing_earlybird" ? (
                        <div className="flex items-start gap-4 px-6 py-5 rounded-2xl border border-soon/25 bg-soon/6">
                            <span className="w-9 h-9 shrink-0 rounded-xl grid place-items-center bg-soon/15 text-soon ring-1 ring-soon/30">
                                <Clock className="w-5 h-5" />
                            </span>
                            <div className="min-w-0">
                                <p className="text-sm font-black text-soon uppercase tracking-[0.14em]">{t("earlyBirdGraceTitle")}</p>
                                <p className="text-[12px] text-fg-60 mt-1.5 leading-relaxed">
                                    {t("earlyBirdGraceBody", { date: s?.trial_end ? new Date(s.trial_end).toLocaleDateString(intlLocale) : "" })}
                                </p>
                            </div>
                        </div>
                    ) : (
                        <SuspendedBanner />
                    )}
                    <h2 className="font-mono text-[11px] text-fg-40 uppercase tracking-[0.22em]">{t("subscribeHeading")}</h2>
                    <div className="grid sm:grid-cols-2 gap-4">
                        <div className="glass rounded-[2rem] p-6 sm:p-8 flex flex-col gap-6 border border-hairline">
                            <div>
                                <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-fg-40 mb-2">{t("monthlyPlan")}</p>
                                <p className="text-3xl font-medium tracking-tight tabular-nums">
                                    {money(prices?.monthly) ?? "—"}
                                    <span className="text-sm text-fg-40 font-medium ml-1">{tCard("perMonth")}</span>
                                </p>
                                <p className="text-[11px] text-fg-40 font-medium mt-2">{tCard("vatMonthly")}</p>
                            </div>
                            <button
                                onClick={() => handleSubscribe("monthly")}
                                disabled={!!subscribing}
                                className="w-full py-4 rounded-2xl font-mono text-[10px] uppercase tracking-[0.18em] bg-veil border border-hairline hover:border-rule hover:bg-fg/10 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                            >
                                {subscribing === "monthly" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                                {t("btnSubscribeMonthly")}
                            </button>
                        </div>
                        <div className="glass rounded-[2rem] p-6 sm:p-8 flex flex-col gap-6 border border-accent/30 bg-accent/4">
                            <div>
                                <div className="flex items-center gap-2 mb-2">
                                    <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-fg-40">{t("annualPlan")}</p>
                                    {savedPercent !== null && (
                                        <span className="px-2 py-0.5 rounded-md font-mono text-[9px] uppercase tracking-[0.18em] bg-accent-hot/15 text-accent-hot border border-accent-hot/25">{tCard("savePercent", { pct: savedPercent })}</span>
                                    )}
                                </div>
                                <p className="text-3xl font-medium tracking-tight tabular-nums">
                                    {money(prices?.annual) ?? "—"}
                                    <span className="text-sm text-fg-40 font-medium ml-1">{tCard("perYear")}</span>
                                </p>
                                <p className="text-[11px] text-fg-40 font-medium mt-2">{tCard("vatAnnualPlain")}</p>
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

            {/* The campaign. Here rather than behind a menu entry of its own:
                two free months are a billing fact, and this is where a merchant
                already thinks about what they pay. The card takes itself off the
                page once the campaign is over. */}
            <section className="space-y-4">
                <div className="flex items-center gap-3">
                    <Gift className="w-5 h-5 text-fg-40" />
                    <h2 className="font-mono text-[11px] text-fg-40 uppercase tracking-[0.22em]">{t("referralHeading")}</h2>
                </div>
                <ReferralCard />
            </section>

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
                                        <tr key={e.id} className={cn("border-b border-hairline hover:bg-fg/[0.02] transition-colors", isRefund && "bg-destructive/5")}>
                                            <td className="px-6 py-4 text-sm text-fg font-medium">{formatDate(e.created_at, intlLocale)}</td>
                                            <td className="px-6 py-4 text-xs text-fg-60 font-mono">{formatRef(e.payment_intent_id, e.stripe_object_id)}</td>
                                            <td className={cn("px-6 py-4 text-sm font-medium text-right tabular-nums", isRefund ? "text-destructive" : "text-fg")}>
                                                {isRefund ? "-" : ""}{formatAmount(e.amount_cents, e.currency, intlLocale)}
                                            </td>
                                            <td className="px-6 py-4"><StatusBadge status={e.status} type={e.type} t={t} /></td>
                                            <td className="px-6 py-4">
                                                {e.ix_invoice_permalink ? (
                                                    <a href={e.ix_invoice_permalink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-xs font-medium text-accent-ink hover:text-accent-hot transition-colors">
                                                        {isRefund ? t("viewCreditNote") : t("viewInvoice")}
                                                        <ExternalLink className="w-3 h-3" />
                                                        {e.ix_match_method === "heuristic" && (
                                                            <span className="font-mono text-[10px] text-soon uppercase tracking-[0.22em]" title={t("heuristicTooltip", { score: e.ix_match_score ?? "" })}>~</span>
                                                        )}
                                                    </a>
                                                ) : canHaveKaptaDocument(e) ? (
                                                    <span className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">{t("processing")}</span>
                                                ) : (
                                                    // A failed attempt is never invoiced: "A processar"
                                                    // beside one would promise a document that never comes.
                                                    <span className="font-mono text-[10px] text-fg-40">—</span>
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
