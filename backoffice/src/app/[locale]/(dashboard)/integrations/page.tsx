"use client";

export const runtime = "edge";

import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect } from "react";
import { Store, ClipboardList, Wallet, CreditCard, Landmark, ArrowRight, Lock, CheckCircle2, Trash2, AlertTriangle, Loader2 } from "lucide-react";
import Image from "next/image";
import { Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

// Ships dark: until the platform is live on Rioko's Stripe account the tile is
// rendered locked, exactly like the payment providers we have not built yet.
const STRIPE_CONNECT_ENABLED = process.env.NEXT_PUBLIC_STRIPE_CONNECT_ENABLED === "1";

const PAYMENT_PLATFORMS = [
    { id: "shopify", name: "Shopify", icon: Store, logo: "/images/shopify-logo.webp", logoW: 28, logoH: 28, active: true },
    { id: "stripe", name: "Stripe Legacy", icon: CreditCard, logo: "/images/stripe-logo.svg", logoW: 28, logoH: 28, active: true },
    // The same Stripe, connected in one click instead of by pasting a restricted
    // key. A separate tile because it is a separate connection: an account can
    // hold both, and support has to be able to tell which one is being discussed.
    { id: "stripe_connect", name: "Stripe Connect", icon: CreditCard, logo: "/images/stripe-logo.svg", logoW: 28, logoH: 28, active: STRIPE_CONNECT_ENABLED },
    { id: "eupago", name: "EuPago", icon: Wallet, logo: "/images/eupago-logo.svg", logoW: 30, logoH: 30, active: true },
    { id: "lodgify", name: "Lodgify", icon: Wallet, logo: "/images/lodgify-logo-white.svg", logoW: 44, logoH: 12, active: true },
    { id: "easypay", name: "Easypay", icon: Wallet, logo: null, logoW: 0, logoH: 0, active: false },
    { id: "ifthenpay", name: "Ifthenpay", icon: Landmark, logo: null, logoW: 0, logoH: 0, active: false },
];

const INVOICING_PLATFORMS = [
    { id: "invoicexpress", name: "InvoiceXpress", icon: ClipboardList, logo: "/images/invoicexpress_logo2.png", logoW: 30, logoH: 30, active: true },
    { id: "moloni", name: "Moloni", icon: ClipboardList, logo: "/images/moloni-logo.svg", logoW: 30, logoH: 30, active: true },
    { id: "vendus", name: "Vendus", icon: ClipboardList, logo: "/images/vendus-logo.svg", logoW: 30, logoH: 30, active: true },
];

export default function IntegrationsPage() {
    const t = useTranslations("integrationsIndex");
    const [selectedPayment, setSelectedPayment] = useState<string | null>(null);
    const [selectedInvoicing, setSelectedInvoicing] = useState<string | null>(null);
    const [activeIntegrations, setActiveIntegrations] = useState<any[]>([]);
    const [subBlocked, setSubBlocked] = useState(false);
    // Deleting an integration throws away credentials and an authorisation, so
    // it asks the merchant to type the pair's name. A dialog you can dismiss with
    // one stray Enter is not a confirmation.
    const [pendingDelete, setPendingDelete] = useState<any | null>(null);
    const [typed, setTyped] = useState("");
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState("");

    useEffect(() => {
        Promise.all([
            fetch("/api/integrations").then(r => r.json()).catch(() => ({})),
            fetch("/api/connections").then(r => r.json()).catch(() => ({ connections: [] })),
            fetch("/api/billing/subscription").then(r => r.ok ? r.json() : null).catch(() => null),
        ]).then(([data, connData, subData]: [any, any, any]) => {
            setSubBlocked(!!subData?.blocked);
            const list: any[] = [];
            if (data.shopify_domain && data.ix_account_name) {
                list.push({
                    id: "shopify-ix", payment: "shopify", invoicing: "invoicexpress",
                    href: "/integrations/shopify-ix",
                    status: data.shopify_authorized && data.ix_authorized && data.webhooks_active ? "authorized" : "pending"
                });
            }
            // Every connection the merchant has started, including drafts.
            //
            // Drafts used to be hidden, which meant a half-finished setup simply
            // vanished: the merchant had to remember which two platforms they had
            // picked and re-select them to find their own data again. An
            // integration you cannot see is one you cannot finish and cannot
            // delete.
            const setup = (connData.connections || []).filter(
                (c: any) => c.status === "active" || c.status === "paused" || c.status === "draft"
            );
            for (const conn of setup) {
                const id = `${conn.source_kind}-${conn.destination_kind}`;
                if (list.find(i => i.id === id)) continue;
                const dest = conn.destination_kind === "invoicexpress" ? "ix" : conn.destination_kind;
                // The route is kebab-cased; the kind is snake_cased. Without this
                // an active Connect integration links to a 404.
                const src = conn.source_kind === "stripe_connect" ? "stripe-connect" : conn.source_kind;
                list.push({
                    id, payment: conn.source_kind, invoicing: conn.destination_kind,
                    sourceKind: conn.source_kind, destinationKind: conn.destination_kind,
                    href: `/integrations/${src}-${dest}`,
                    status: conn.status === "draft" ? "draft" : "authorized",
                    deletable: true,
                });
            }
            setActiveIntegrations(list);
        });
    }, []);

    // Active combinations:
    //   shopify   + ix          → /integrations/shopify-ix (legacy IX-direct)
    //   shopify   + moloni      → /integrations/shopify-moloni (pipeline, B2B EU warning)
    //   shopify   + vendus      → /integrations/shopify-vendus (pipeline, B2B EU warning)
    //   stripe    + ix          → /integrations/stripe-ix
    //   stripe    + moloni      → /integrations/stripe-moloni
    //   stripe    + vendus      → /integrations/stripe-vendus
    //   eupago    + ix          → /integrations/eupago-ix (Consumidor Final default)
    // eupago+moloni / eupago+vendus / easypay / ifthenpay still gated.
    const canConnect =
        (selectedPayment === "shopify" && ["invoicexpress", "moloni", "vendus"].includes(selectedInvoicing ?? ""))
        || (selectedPayment === "stripe" && ["invoicexpress", "moloni", "vendus"].includes(selectedInvoicing ?? ""))
        || (STRIPE_CONNECT_ENABLED && selectedPayment === "stripe_connect" && ["moloni", "invoicexpress"].includes(selectedInvoicing ?? ""))
        || (selectedPayment === "eupago" && selectedInvoicing === "invoicexpress")
        || (selectedPayment === "lodgify" && selectedInvoicing === "invoicexpress")
        || (selectedPayment === "lodgify" && selectedInvoicing === "moloni")
        || (selectedPayment === "lodgify" && selectedInvoicing === "vendus");
    const configuratorHref = (() => {
        if (selectedPayment === "lodgify" && selectedInvoicing === "invoicexpress") return "/integrations/lodgify-ix";
        if (selectedPayment === "lodgify" && selectedInvoicing === "moloni") return "/integrations/lodgify-moloni";
        if (selectedPayment === "lodgify" && selectedInvoicing === "vendus") return "/integrations/lodgify-vendus";
        if (selectedPayment === "eupago" && selectedInvoicing === "invoicexpress") return "/integrations/eupago-ix";
        if (selectedPayment === "stripe_connect" && selectedInvoicing === "moloni") return "/integrations/stripe-connect-moloni";
        if (selectedPayment === "stripe_connect" && selectedInvoicing === "invoicexpress") return "/integrations/stripe-connect-ix";
        if (selectedPayment === "stripe" && selectedInvoicing === "moloni") return "/integrations/stripe-moloni";
        if (selectedPayment === "stripe" && selectedInvoicing === "vendus") return "/integrations/stripe-vendus";
        if (selectedPayment === "shopify" && selectedInvoicing === "moloni") return "/integrations/shopify-moloni";
        if (selectedPayment === "shopify" && selectedInvoicing === "vendus") return "/integrations/shopify-vendus";
        if (selectedPayment === "stripe") return "/integrations/stripe-ix";
        return "/integrations/shopify-ix";
    })();

    const confirmPhrase = pendingDelete
        ? `${pendingDelete.sourceKind}:${pendingDelete.destinationKind}`
        : "";

    const handleDelete = async () => {
        if (!pendingDelete || typed.trim() !== confirmPhrase) return;
        setDeleting(true);
        setDeleteError("");
        try {
            const qs = new URLSearchParams({
                source_kind: pendingDelete.sourceKind,
                destination_kind: pendingDelete.destinationKind,
                confirm: confirmPhrase,
            });
            const res = await fetch(`/api/connections?${qs}`, { method: "DELETE" });
            const json: any = await res.json().catch(() => ({}));
            if (!res.ok) {
                setDeleteError(json.error ?? `HTTP ${res.status}`);
                return;
            }
            setActiveIntegrations(prev => prev.filter(i => i.id !== pendingDelete.id));
            setPendingDelete(null);
            setTyped("");
        } catch (e: any) {
            setDeleteError(e?.message ?? "Unknown error");
        } finally {
            setDeleting(false);
        }
    };

    return (
        <div className="max-w-6xl mx-auto space-y-16 animate-in fade-in duration-1000 slide-in-from-bottom-4">
            <div className="space-y-4 text-center md:text-left">
                <h1 className="text-3xl sm:text-4xl lg:text-5xl font-medium tracking-tight bg-gradient-to-r from-fg via-fg to-fg-40 bg-clip-text text-transparent">
                    {t("title")}
                </h1>
                <p className="text-fg-60 font-medium tracking-wide">
                    {t("subtitle")}
                </p>
            </div>

            {pendingDelete && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-scrim backdrop-blur-sm">
                    <div className="glass rounded-[2rem] max-w-lg w-full p-8 space-y-6 border border-destructive/25">
                        <div className="flex items-start gap-4">
                            <div className="p-3 rounded-2xl bg-destructive/10 shrink-0">
                                <AlertTriangle className="w-6 h-6 text-destructive" />
                            </div>
                            <div className="space-y-2">
                                <h3 className="text-xl font-medium tracking-tight">{t("deleteTitle")}</h3>
                                <p className="text-sm text-fg-60 leading-relaxed">{t("deleteBody")}</p>
                                <p className="text-[11px] text-fg-40 leading-relaxed">{t("deleteKeepsHistory")}</p>
                            </div>
                        </div>

                        <div className="space-y-3">
                            <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] block">
                                {t("deleteTypeToConfirm")}
                            </label>
                            <code className="block bg-surface-2/60 border border-hairline rounded-xl px-4 py-3 text-sm font-mono select-all">
                                {confirmPhrase}
                            </code>
                            <input
                                type="text"
                                value={typed}
                                onChange={(e) => setTyped(e.target.value)}
                                autoComplete="off"
                                spellCheck={false}
                                placeholder={confirmPhrase}
                                className="w-full bg-surface-2/50 border border-hairline rounded-xl px-4 py-3 text-sm font-mono focus:ring-2 focus:ring-destructive/20 focus:border-destructive/45 outline-none transition-all placeholder:text-fg-40"
                            />
                        </div>

                        {deleteError && <p className="text-[11px] text-destructive font-bold">{deleteError}</p>}

                        <div className="flex items-center gap-3 pt-2">
                            <button
                                onClick={() => { setPendingDelete(null); setTyped(""); setDeleteError(""); }}
                                className="flex-1 py-4 rounded-2xl border border-hairline hover:border-rule text-[10px] font-black uppercase tracking-[0.18em] transition-colors"
                            >
                                {t("deleteCancel")}
                            </button>
                            <button
                                onClick={handleDelete}
                                disabled={deleting || typed.trim() !== confirmPhrase}
                                className="flex-1 py-4 rounded-2xl bg-destructive text-on-accent text-[10px] font-black uppercase tracking-[0.18em] transition-all disabled:opacity-25 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                            >
                                {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                                {t("deleteConfirm")}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {activeIntegrations.length > 0 && (
                <section className="space-y-6">
                    <h2 className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em] ml-2">{t("activeSection")}</h2>
                    <div className="space-y-4">
                        {activeIntegrations.map(ai => {
                            const payP = PAYMENT_PLATFORMS.find(p => p.id === ai.payment);
                            const invP = INVOICING_PLATFORMS.find(p => p.id === ai.invoicing);
                            const PayIcon = payP?.icon ?? Store;
                            const InvIcon = invP?.icon ?? ClipboardList;
                            const title = `${payP?.name ?? ai.payment} + ${invP?.name ?? ai.invoicing}`;
                            return (
                                <div key={ai.id} className="glass rounded-[2.5rem] p-5 sm:p-8 relative overflow-hidden group">
                                    <div className="absolute top-0 right-0 p-5 sm:p-8 opacity-5">
                                        <CheckCircle2 className="w-32 h-32 text-accent-hot" />
                                    </div>
                                    <div className="flex flex-col md:flex-row items-center justify-between gap-8 relative z-10">
                                        <div className="flex items-center gap-8">
                                            <div className="flex -space-x-4">
                                                <div className="w-16 h-16 rounded-2xl bg-veil border border-hairline flex items-center justify-center backdrop-blur-xl ring-4 ring-surface shadow-2xl p-3">
                                                    {payP?.logo ? <Image src={payP.logo} alt={payP.name} width={36} height={36} className={cn("object-contain", payP.logo.includes("-white") && "logo-adaptive")} /> : <PayIcon className="w-8 h-8 text-fg" />}
                                                </div>
                                                <div className="w-16 h-16 rounded-2xl bg-veil border border-hairline flex items-center justify-center backdrop-blur-xl ring-4 ring-surface shadow-2xl p-3">
                                                    {invP?.logo ? <Image src={invP.logo} alt={invP.name} width={36} height={36} className={cn("object-contain", invP.logo.includes("-white") && "logo-adaptive")} /> : <InvIcon className="w-8 h-8 text-fg" />}
                                                </div>
                                            </div>
                                            <div className="space-y-1">
                                                <h3 className="text-2xl font-medium tracking-tight">{title}</h3>
                                                <div className="flex items-center gap-3">
                                                    <span className={cn(
                                                        "px-2 py-0.5 rounded-md font-mono text-[10px] uppercase tracking-[0.22em] border",
                                                        !subBlocked && ai.status === "authorized"
                                                            ? "bg-accent-hot/10 text-accent-hot border-accent-hot/20"
                                                            : "bg-soon/10 text-soon border-soon/20"
                                                    )}>
                                                        {ai.status === "draft"
                                                            ? t("statusPending")
                                                            : subBlocked ? t("statusIncomplete") : t("statusAuthorized")}
                                                    </span>
                                                    <span className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">{t("realtimeSync")}</span>
                                                </div>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            <Link
                                                href={ai.href}
                                                className="px-5 sm:px-8 py-4 rounded-2xl bg-fg text-surface font-mono text-xs uppercase tracking-[0.18em] hover:bg-accent-hot transition-all transform active:scale-95 flex items-center gap-3 shadow-[0_8px_30px_-12px_color-mix(in_srgb,var(--accent)_45%,transparent)]"
                                            >
                                                {ai.status === "draft" ? t("resumeSetup") : t("manageSettings")} <ArrowRight className="w-4 h-4" />
                                            </Link>
                                            {ai.deletable && (
                                                <button
                                                    onClick={() => { setPendingDelete(ai); setTyped(""); setDeleteError(""); }}
                                                    title={t("deleteIntegration")}
                                                    aria-label={t("deleteIntegration")}
                                                    className="p-4 rounded-2xl border border-destructive/25 text-destructive hover:bg-destructive/10 hover:border-destructive/45 transition-all"
                                                >
                                                    <Trash2 className="w-4 h-4" />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </section>
            )}

            <div className="grid lg:grid-cols-2 gap-12">
                {/* Payment Platforms */}
                <div className="space-y-6">
                    <h2 className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em] ml-2">{t("paymentPlatform")}</h2>
                    <div className="grid gap-3">
                        {PAYMENT_PLATFORMS.map((p) => {
                            const Icon = p.icon;
                            return (
                                <button
                                    key={p.id}
                                    onClick={() => p.active && setSelectedPayment(p.id)}
                                    className={cn(
                                        "glass p-6 rounded-[2rem] border transition-all flex items-center justify-between group",
                                        !p.active ? "opacity-40 grayscale cursor-not-allowed border-hairline" :
                                            selectedPayment === p.id ? "border-accent/40 bg-accent/4" : "border-hairline hover:border-rule"
                                    )}
                                >
                                    <div className="flex items-center gap-5">
                                        <div className={cn(
                                            "w-14 h-14 rounded-2xl flex items-center justify-center transition-colors",
                                            selectedPayment === p.id ? "bg-accent/18 text-accent-ink" : "bg-surface-2 text-fg-40 group-hover:text-fg-60"
                                        )}>
                                            {p.logo ? <Image src={p.logo} alt={p.name} width={p.logoW} height={p.logoH} className={cn("object-contain", p.logo.includes("-white") && "logo-adaptive")} /> : <Icon className="w-6 h-6" />}
                                        </div>
                                        <div className="text-left">
                                            <p className="font-medium text-lg text-fg">{p.name}</p>
                                            <p className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">
                                                {!p.active ? t("comingSoon") : t("available")}
                                            </p>
                                        </div>
                                    </div>
                                    {!p.active && <Lock className="w-4 h-4 text-fg-40" />}
                                    {selectedPayment === p.id && <div className="w-2 h-2 rounded-full bg-accent-hot animate-pulse" />}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* Invoicing Platforms */}
                <div className="space-y-6">
                    <h2 className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em] ml-2">{t("invoicingPlatform")}</h2>
                    <div className="grid gap-3">
                        {INVOICING_PLATFORMS.map((p) => {
                            const Icon = p.icon;
                            return (
                                <button
                                    key={p.id}
                                    onClick={() => p.active && setSelectedInvoicing(p.id)}
                                    className={cn(
                                        "glass p-6 rounded-[2rem] border transition-all flex items-center justify-between group",
                                        !p.active ? "opacity-40 grayscale cursor-not-allowed border-hairline" :
                                            selectedInvoicing === p.id ? "border-accent/40 bg-accent/4" : "border-hairline hover:border-rule"
                                    )}
                                >
                                    <div className="flex items-center gap-5">
                                        <div className={cn(
                                            "w-14 h-14 rounded-2xl flex items-center justify-center transition-colors",
                                            selectedInvoicing === p.id ? "bg-accent/18 text-accent-ink" : "bg-surface-2 text-fg-40 group-hover:text-fg-60"
                                        )}>
                                            {p.logo ? <Image src={p.logo} alt={p.name} width={p.logoW} height={p.logoH} className={cn("object-contain", p.logo.includes("-white") && "logo-adaptive")} /> : <Icon className="w-6 h-6" />}
                                        </div>
                                        <div className="text-left">
                                            <p className="font-medium text-lg text-fg">{p.name}</p>
                                            <p className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">
                                                {!p.active ? t("comingSoon") : t("available")}
                                            </p>
                                        </div>
                                    </div>
                                    {!p.active && <Lock className="w-4 h-4 text-fg-40" />}
                                    {selectedInvoicing === p.id && <div className="w-2 h-2 rounded-full bg-accent-hot animate-pulse" />}
                                </button>
                            );
                        })}
                    </div>

                    <AnimatePresence>
                        {selectedInvoicing && selectedPayment && (
                            <motion.div
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, scale: 0.95 }}
                                className="pt-8"
                            >
                                <div
                                    className={cn(
                                        "p-6 sm:p-10 rounded-[2.5rem] flex flex-col items-center gap-8 text-center",
                                        canConnect ? "text-on-accent" : "bg-surface-2 border border-hairline"
                                    )}
                                    style={
                                        canConnect
                                            ? {
                                                  background:
                                                      "linear-gradient(135deg, var(--accent) 0%, color-mix(in srgb, var(--accent) 80%, black) 100%)",
                                                  boxShadow:
                                                      "inset 0 1px 0 color-mix(in srgb, var(--on-accent) 15%, transparent), 0 0 40px -10px color-mix(in srgb, var(--accent) 55%, transparent), 0 12px 30px -16px var(--scrim)",
                                              }
                                            : undefined
                                    }
                                >
                                    <div className="flex -space-x-4">
                                        <div className="w-20 h-20 rounded-[1.8rem] bg-media-plate text-on-media flex items-center justify-center ring-8 ring-surface p-3">
                                            {selectedPayment === "shopify" ? <Store className="w-10 h-10" />
                                                : selectedPayment === "lodgify" ? <Image src="/images/lodgify-logo-black.svg" alt="Lodgify" width={56} height={15} className="object-contain" />
                                                : selectedPayment === "eupago" ? <Image src="/images/eupago-logo.svg" alt="EuPago" width={40} height={40} className="object-contain" />
                                                : <CreditCard className="w-10 h-10" />}
                                        </div>
                                        <div className="w-20 h-20 rounded-[1.8rem] bg-surface-2 text-fg flex items-center justify-center ring-8 ring-surface border border-hairline p-3">
                                            {selectedInvoicing === "invoicexpress" ? <Image src="/images/invoicexpress_logo2.png" alt="InvoiceXpress" width={40} height={40} className="object-contain" />
                                                : selectedInvoicing === "moloni" ? <Image src="/images/moloni-logo.svg" alt="Moloni" width={40} height={40} className="object-contain" />
                                                : selectedInvoicing === "vendus" ? <Image src="/images/vendus-logo.svg" alt="Vendus" width={40} height={40} className="object-contain" />
                                                : <ClipboardList className="w-10 h-10" />}
                                        </div>
                                    </div>
                                    <div className="space-y-2">
                                        <h3 className="text-2xl font-medium">{t("readyToConnect")}</h3>
                                        <p className={cn("text-sm max-w-xs mx-auto", canConnect ? "text-on-accent/80" : "text-fg-60")}>
                                            {t("readyBody")}
                                        </p>
                                    </div>
                                    {canConnect ? (
                                        <Link
                                            href={configuratorHref}
                                            className="w-full py-5 rounded-3xl bg-fg text-surface font-mono text-sm uppercase tracking-[0.18em] hover:bg-accent-hot hover:text-surface transition-all transform active:scale-95"
                                        >
                                            {t("configureNow")}
                                        </Link>
                                    ) : (
                                        <button disabled className="w-full py-5 rounded-3xl bg-surface-2 text-fg-40 font-mono text-sm uppercase tracking-[0.18em] cursor-not-allowed opacity-50 border border-hairline">
                                            {t("unavailableCombo")}
                                        </button>
                                    )}
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            </div>
        </div>
    );
}
