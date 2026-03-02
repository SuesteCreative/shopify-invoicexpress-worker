"use client";

export const runtime = "edge";

import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect } from "react";
import { Store, ClipboardList, Wallet, CreditCard, Landmark, ArrowRight, Lock, CheckCircle2 } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

const PAYMENT_PLATFORMS = [
    { id: "shopify", name: "Shopify", icon: Store, logo: "/images/shopify-logo.webp", logoW: 28, logoH: 28, active: true },
    { id: "stripe", name: "Stripe", icon: CreditCard, logo: null, logoW: 0, logoH: 0, active: false },
    { id: "eupago", name: "EuPago", icon: Wallet, logo: null, logoW: 0, logoH: 0, active: false },
    { id: "easypay", name: "Easypay", icon: Wallet, logo: null, logoW: 0, logoH: 0, active: false },
    { id: "ifthenpay", name: "Ifthenpay", icon: Landmark, logo: null, logoW: 0, logoH: 0, active: false },
];

const INVOICING_PLATFORMS = [
    { id: "invoicexpress", name: "InvoiceXpress", icon: ClipboardList, logo: "/images/invoicexpress_logo2.png", logoW: 30, logoH: 30, active: true },
    { id: "moloni", name: "Moloni", icon: ClipboardList, logo: null, logoW: 0, logoH: 0, active: false },
];

export default function IntegrationsPage() {
    const [selectedPayment, setSelectedPayment] = useState<string | null>(null);
    const [selectedInvoicing, setSelectedInvoicing] = useState<string | null>(null);
    const [activeIntegration, setActiveIntegration] = useState<any>(null);

    useEffect(() => {
        fetch("/api/integrations")
            .then(res => res.json())
            .then((data: any) => {
                // Simple logic: if shopify and ix are set up, mark as active
                if (data.shopify_domain && data.ix_account_name) {
                    setActiveIntegration({
                        id: "shopify-ix",
                        payment: "shopify",
                        invoicing: "invoicexpress",
                        status: data.shopify_authorized && data.ix_authorized && data.webhooks_active ? "authorized" : "pending"
                    });
                }
            });
    }, []);

    const canConnect = selectedPayment === "shopify" && selectedInvoicing === "invoicexpress";

    return (
        <div className="max-w-6xl mx-auto space-y-16 animate-in fade-in duration-1000 slide-in-from-bottom-4">
            <div className="space-y-4 text-center md:text-left">
                <h1 className="text-5xl font-black tracking-tight bg-gradient-to-r from-white via-white/80 to-slate-500 bg-clip-text text-transparent">
                    Integrações
                </h1>
                <p className="text-slate-400 font-semibold tracking-wide">
                    Escolha as plataformas que deseja conectar ao seu motor Rioko.
                </p>
            </div>

            {activeIntegration && (
                <section className="space-y-6">
                    <h2 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] ml-2">Integrações Ativas</h2>
                    <div className="glass rounded-[2.5rem] p-8 border-slate-800/40 relative overflow-hidden group">
                        <div className="absolute top-0 right-0 p-8 opacity-5">
                            <CheckCircle2 className="w-32 h-32 text-emerald-400" />
                        </div>
                        <div className="flex flex-col md:flex-row items-center justify-between gap-8 relative z-10">
                            <div className="flex items-center gap-8">
                                <div className="flex -space-x-4">
                                    <div className="w-16 h-16 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center backdrop-blur-xl ring-4 ring-slate-950 shadow-2xl">
                                        <Store className="w-8 h-8 text-emerald-400" />
                                    </div>
                                    <div className="w-16 h-16 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center backdrop-blur-xl ring-4 ring-slate-950 shadow-2xl">
                                        <ClipboardList className="w-8 h-8 text-sky-400" />
                                    </div>
                                </div>
                                <div className="space-y-1">
                                    <h3 className="text-2xl font-black tracking-tight">Shopify + InvoiceXpress</h3>
                                    <div className="flex items-center gap-3">
                                        <span className={cn(
                                            "px-2 px-1 rounded-md text-[9px] font-black uppercase tracking-widest border",
                                            activeIntegration.status === "authorized" ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" : "bg-amber-500/10 text-amber-500 border-amber-500/20"
                                        )}>
                                            {activeIntegration.status === "authorized" ? "Autorizado" : "Configuração Pendente"}
                                        </span>
                                        <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Sincronização em tempo real</span>
                                    </div>
                                </div>
                            </div>
                            <Link
                                href="/integrations/shopify-ix"
                                className="px-8 py-4 rounded-2xl bg-white text-black font-black text-xs uppercase tracking-widest hover:bg-emerald-400 hover:text-white transition-all transform active:scale-95 flex items-center gap-3 shadow-xl shadow-white/5"
                            >
                                Gerir Definições <ArrowRight className="w-4 h-4" />
                            </Link>
                        </div>
                    </div>
                </section>
            )}

            <div className="grid lg:grid-cols-2 gap-12">
                {/* Payment Platforms */}
                <div className="space-y-6">
                    <h2 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] ml-2">Plataforma de Pagamento / E-commerce</h2>
                    <div className="grid gap-3">
                        {PAYMENT_PLATFORMS.map((p) => {
                            const Icon = p.icon;
                            return (
                                <button
                                    key={p.id}
                                    onClick={() => p.active && setSelectedPayment(p.id)}
                                    className={cn(
                                        "glass p-6 rounded-[2rem] border transition-all flex items-center justify-between group",
                                        !p.active ? "opacity-40 grayscale cursor-not-allowed border-slate-800/20" :
                                            selectedPayment === p.id ? "border-emerald-500/40 bg-emerald-500/[0.03] shadow-[0_0_30px_rgba(16,185,129,0.1)]" : "border-slate-800/40 hover:border-slate-700/60"
                                    )}
                                >
                                    <div className="flex items-center gap-5">
                                        <div className={cn(
                                            "w-14 h-14 rounded-2xl flex items-center justify-center transition-colors",
                                            selectedPayment === p.id ? "bg-emerald-500/20 text-emerald-400" : "bg-slate-900/50 text-slate-500 group-hover:text-slate-300"
                                        )}>
                                            {p.logo ? <Image src={p.logo} alt={p.name} width={p.logoW} height={p.logoH} className="object-contain" /> : <Icon className="w-6 h-6" />}
                                        </div>
                                        <div className="text-left">
                                            <p className="font-bold text-lg">{p.name}</p>
                                            <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest">
                                                {!p.active ? "Brevemente" : "Disponível"}
                                            </p>
                                        </div>
                                    </div>
                                    {!p.active && <Lock className="w-4 h-4 text-slate-700" />}
                                    {selectedPayment === p.id && <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* Invoicing Platforms */}
                <div className="space-y-6">
                    <h2 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] ml-2">Plataforma de Faturação</h2>
                    <div className="grid gap-3">
                        {INVOICING_PLATFORMS.map((p) => {
                            const Icon = p.icon;
                            return (
                                <button
                                    key={p.id}
                                    onClick={() => p.active && setSelectedInvoicing(p.id)}
                                    className={cn(
                                        "glass p-6 rounded-[2rem] border transition-all flex items-center justify-between group",
                                        !p.active ? "opacity-40 grayscale cursor-not-allowed border-slate-800/20" :
                                            selectedInvoicing === p.id ? "border-sky-500/40 bg-sky-500/[0.03] shadow-[0_0_30px_rgba(56,189,248,0.1)]" : "border-slate-800/40 hover:border-slate-700/60"
                                    )}
                                >
                                    <div className="flex items-center gap-5">
                                        <div className={cn(
                                            "w-14 h-14 rounded-2xl flex items-center justify-center transition-colors",
                                            selectedInvoicing === p.id ? "bg-sky-500/20 text-sky-400" : "bg-slate-900/50 text-slate-500 group-hover:text-slate-300"
                                        )}>
                                            {p.logo ? <Image src={p.logo} alt={p.name} width={p.logoW} height={p.logoH} className="object-contain" /> : <Icon className="w-6 h-6" />}
                                        </div>
                                        <div className="text-left">
                                            <p className="font-bold text-lg">{p.name}</p>
                                            <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest">
                                                {!p.active ? "Brevemente" : "Disponível"}
                                            </p>
                                        </div>
                                    </div>
                                    {!p.active && <Lock className="w-4 h-4 text-slate-700" />}
                                    {selectedInvoicing === p.id && <div className="w-2 h-2 rounded-full bg-sky-500 animate-pulse" />}
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
                                <div className={cn(
                                    "p-10 rounded-[2.5rem] border flex flex-col items-center gap-8 text-center",
                                    canConnect ? "bg-emerald-500/[0.02] border-emerald-500/20" : "bg-slate-900/30 border-slate-800/50"
                                )}>
                                    <div className="flex -space-x-4">
                                        <div className="w-20 h-20 rounded-[1.8rem] bg-white text-black flex items-center justify-center ring-8 ring-slate-950">
                                            {selectedPayment === "shopify" ? <Store className="w-10 h-10" /> : <CreditCard className="w-10 h-10" />}
                                        </div>
                                        <div className="w-20 h-20 rounded-[1.8rem] bg-slate-900 text-white flex items-center justify-center ring-8 ring-slate-950 border border-white/10">
                                            <ClipboardList className="w-10 h-10" />
                                        </div>
                                    </div>
                                    <div className="space-y-2">
                                        <h3 className="text-2xl font-black">Pronto para Conectar?</h3>
                                        <p className="text-slate-400 text-sm max-w-xs mx-auto">
                                            Inicie o guia de configuração de 4 passos para automatizar a sua faturação.
                                        </p>
                                    </div>
                                    {canConnect ? (
                                        <Link
                                            href="/integrations/shopify-ix"
                                            className="w-full py-5 rounded-3xl bg-emerald-500 text-white font-black text-sm uppercase tracking-widest hover:bg-emerald-400 transition-all transform active:scale-95 shadow-xl shadow-emerald-500/10"
                                        >
                                            Configurar Agora
                                        </Link>
                                    ) : (
                                        <button disabled className="w-full py-5 rounded-3xl bg-slate-800 text-slate-500 font-black text-sm uppercase tracking-widest cursor-not-allowed opacity-50">
                                            Combinação Indisponível
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
