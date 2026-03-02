"use client";

export const runtime = "edge";

import { motion } from "framer-motion";
import { useState, useEffect } from "react";
import { Activity, ShieldCheck, ClipboardList, Settings2, BookOpen, Plus, Store, CheckCircle2, Zap, ArrowRight, TrendingUp, Package, AlertCircle } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

import { RegistrationForm } from "@/components/RegistrationForm";

export default function WelcomeDashboard() {
  const { user: clerkUser } = useUser();
  const [dbUserName, setDbUserName] = useState("");
  const firstName = (dbUserName || clerkUser?.firstName || clerkUser?.fullName || "").split(" ")[0];
  const [loading, setLoading] = useState(true);
  const [integrationStatus, setIntegrationStatus] = useState<any>(null);
  const [isRegistered, setIsRegistered] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/integrations")
      .then(res => res.json())
      .then((data: any) => {
        setIsRegistered(data._registration_completed);
        if (data._user_name) setDbUserName(data._user_name);
        if (data.shopify_domain && data.ix_account_name) {
          setIntegrationStatus({
            id: "shopify-ix",
            shopifyAuthorized: data.shopify_authorized === 1,
            ixAuthorized: data.ix_authorized === 1,
            webhooksActive: data.webhooks_active === 1,
            isAllComplete: data.shopify_authorized === 1 && data.ix_authorized === 1 && data.webhooks_active === 1
          });
        }
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="w-12 h-12 border-4 border-sky-500/20 border-t-sky-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (isRegistered === false) {
    return (
      <div className="py-12">
        <RegistrationForm
          onComplete={() => setIsRegistered(true)}
          initialEmail={clerkUser?.primaryEmailAddress?.emailAddress}
          initialName={clerkUser?.fullName || ""}
        />
      </div>
    );
  }

  return (
    <div className="space-y-12 animate-in fade-in duration-1000 slide-in-from-bottom-4">
      {/* Welcome Message */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-8">
        <div className="space-y-2">
          <h1 className="text-5xl font-black tracking-tight bg-gradient-to-r from-white via-white to-slate-500 bg-clip-text text-transparent">
            {firstName ? `Bem-vindo, ${firstName}` : "Bem-vindo"}
          </h1>
          <p className="text-slate-400 font-semibold tracking-wide flex items-center gap-2">
            Rioko 2.0 Engine <span className="w-1 h-1 rounded-full bg-slate-600" /> A sua central de automação e-commerce.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <Link
            href="/integrations"
            className="px-6 py-3 rounded-2xl bg-white text-black font-black text-xs uppercase tracking-widest hover:bg-emerald-400 hover:text-white transition-all transform active:scale-95 flex items-center gap-3 shadow-xl shadow-white/5"
          >
            Nova Integração <Plus className="w-4 h-4" />
          </Link>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-8">
        {/* Quick Stats Placeholder */}
        <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="glass p-8 rounded-[2.5rem] border-slate-800/40 flex flex-col justify-between group overflow-hidden relative">
            <div className="absolute -top-4 -right-4 bg-emerald-500/10 w-32 h-32 rounded-full blur-3xl opacity-0 group-hover:opacity-100 transition-all duration-700" />
            <div className="flex items-center justify-between relative z-10">
              <div className="p-3 bg-emerald-500/10 rounded-2xl border border-emerald-500/20">
                <TrendingUp className="w-6 h-6 text-emerald-400" />
              </div>
              <span className="text-[10px] font-black text-emerald-500 bg-emerald-500/10 px-2 py-1 rounded-lg uppercase tracking-wider">Brevemente</span>
            </div>
            <div className="space-y-1 relative z-10">
              <p className="text-4xl font-black tracking-tighter text-slate-300 opacity-20">---</p>
              <p className="text-sm font-bold text-slate-500 uppercase tracking-widest">Documentos Emitidos</p>
            </div>
          </div>

          <div className="glass p-8 rounded-[2.5rem] border-slate-800/40 flex flex-col justify-between group overflow-hidden relative">
            <div className="absolute -top-4 -right-4 bg-sky-500/10 w-32 h-32 rounded-full blur-3xl opacity-0 group-hover:opacity-100 transition-all duration-700" />
            <div className="flex items-center justify-between relative z-10">
              <div className="p-3 bg-sky-500/10 rounded-2xl border border-sky-500/20">
                <Package className="w-6 h-6 text-sky-400" />
              </div>
              <span className="text-[10px] font-black text-sky-400 bg-sky-400/10 px-2 py-1 rounded-lg uppercase tracking-wider">Brevemente</span>
            </div>
            <div className="space-y-1 relative z-10">
              <p className="text-4xl font-black tracking-tighter text-slate-300 opacity-20">---</p>
              <p className="text-sm font-bold text-slate-500 uppercase tracking-widest">Encomendas Pendentes</p>
            </div>
          </div>
        </div>

        {/* Status Area */}
        <div className="glass p-8 rounded-[2.5rem] border-slate-800/40 space-y-8 flex flex-col justify-between">
          <div className="space-y-4">
            <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] flex items-center gap-2">
              <Activity className="w-3 h-3" /> Estado do Sistema
            </h3>
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-sm font-bold text-slate-300">Rioko Engine Online</span>
            </div>
          </div>

          <div className="pt-8 border-t border-slate-800/50 space-y-4">
            <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Recursos e Ajuda</p>
            <div className="grid gap-2">
              <Link href="/help" className="flex items-center gap-3 p-3 rounded-xl hover:bg-white/5 transition-all group">
                <BookOpen className="w-4 h-4 text-emerald-400" />
                <span className="text-xs font-bold text-slate-400 group-hover:text-white transition-colors">Centro de Ajuda</span>
                <ArrowRight className="w-3 h-3 ml-auto opacity-0 group-hover:opacity-100 transition-all translate-x-[-10px] group-hover:translate-x-0" />
              </Link>
              <a href="mailto:pedro@kapta.pt" className="flex items-center gap-3 p-3 rounded-xl hover:bg-white/5 transition-all group">
                <Zap className="w-4 h-4 text-amber-400" />
                <span className="text-xs font-bold text-slate-400 group-hover:text-white transition-colors">Equipa de Suporte</span>
                <ArrowRight className="w-3 h-3 ml-auto opacity-0 group-hover:opacity-100 transition-all translate-x-[-10px] group-hover:translate-x-0" />
              </a>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-6">
        <h2 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] ml-2">As Suas Integrações</h2>

        {integrationStatus ? (
          <div className="grid gap-6">
            <Link
              href="/integrations/shopify-ix"
              className="glass p-8 rounded-[2.5rem] border-slate-800/40 hover:border-emerald-500/30 transition-all flex flex-col md:flex-row items-center justify-between gap-8 group relative overflow-hidden"
            >
              <div className="absolute top-0 right-0 p-8 opacity-0 group-hover:opacity-5 transition-all">
                <Settings2 className="w-32 h-32 text-emerald-400" />
              </div>
              <div className="flex items-center gap-8 relative z-10 w-full md:w-auto">
                <div className="w-20 h-20 rounded-[1.8rem] bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20 shrink-0">
                  <Store className="w-10 h-10 text-emerald-400" />
                </div>
                <div className="space-y-1">
                  <h3 className="text-2xl font-black tracking-tight group-hover:text-emerald-400 transition-colors">Shopify + InvoiceXpress</h3>
                  <div className="flex items-center gap-3">
                    <span className={cn(
                      "px-2 py-0.5 rounded-lg text-[9px] font-black uppercase tracking-widest border",
                      integrationStatus.isAllComplete ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" : "bg-amber-500/10 text-amber-500 border-amber-500/20"
                    )}>
                      {integrationStatus.isAllComplete ? "Ativa e Autorizada" : "Configuração Pendente"}
                    </span>
                    <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest hidden sm:inline">Desde 2026-03-02</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-6 relative z-10 ml-auto md:ml-0">
                <div className="hidden xl:flex items-center -space-x-2">
                  <div className={cn("w-8 h-8 rounded-full border-4 border-slate-950 flex items-center justify-center", integrationStatus.shopifyAuthorized ? "bg-emerald-500/20 text-emerald-400" : "bg-slate-800 text-slate-600")}><Store className="w-3 h-3" /></div>
                  <div className={cn("w-8 h-8 rounded-full border-4 border-slate-950 flex items-center justify-center", integrationStatus.ixAuthorized ? "bg-emerald-500/20 text-emerald-400" : "bg-slate-800 text-slate-600")}><ClipboardList className="w-3 h-3" /></div>
                </div>
                <ArrowRight className="w-6 h-6 text-slate-700 group-hover:text-emerald-400 group-hover:translate-x-2 transition-all" />
              </div>
            </Link>
          </div>
        ) : (
          <div className="glass p-12 rounded-[3rem] border-slate-800/40 border-dashed flex flex-col items-center gap-6 text-center">
            <div className="w-16 h-16 rounded-2xl bg-slate-900 flex items-center justify-center text-slate-700 border border-slate-800">
              <Plus className="w-8 h-8" />
            </div>
            <div className="space-y-2">
              <h3 className="text-xl font-bold">Nenhuma integração configurada</h3>
              <p className="text-slate-500 text-sm max-w-xs mx-auto">
                Comece por conectar a sua loja Shopify a um sistema de faturação.
              </p>
            </div>
            <Link
              href="/integrations"
              className="px-8 py-3 rounded-2xl bg-white text-black font-black text-xs uppercase tracking-widest hover:bg-emerald-400 hover:text-white transition-all transform active:scale-95 shadow-xl shadow-white/5"
            >
              Explorar Plataformas
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
