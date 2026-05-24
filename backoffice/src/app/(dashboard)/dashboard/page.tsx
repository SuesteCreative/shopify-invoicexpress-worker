"use client";

export const runtime = "edge";

import { motion } from "framer-motion";
import { useState, useEffect } from "react";
import { Activity, ShieldCheck, ClipboardList, Settings2, BookOpen, Plus, Store, CheckCircle2, Zap, ArrowRight, TrendingUp, Package, AlertCircle, ExternalLink, FileText, ScrollText, Inbox } from "lucide-react";
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
  const [recentInvoices, setRecentInvoices] = useState<any[] | null>(null);
  const [recentLogs, setRecentLogs] = useState<any[] | null>(null);

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
            isPaused: data.is_paused === 1,
            isAllComplete: data.shopify_authorized === 1 && data.ix_authorized === 1 && data.webhooks_active === 1
          });
        }
      })
      .finally(() => setLoading(false));

    // Recent activity feeds — fire in parallel, don't block welcome render
    fetch("/api/dashboard/recent-invoices")
      .then(r => r.ok ? r.json() : { invoices: [] })
      .then((d: any) => setRecentInvoices(d.invoices || []))
      .catch(() => setRecentInvoices([]));
    fetch("/api/dashboard/recent-logs")
      .then(r => r.ok ? r.json() : { logs: [] })
      .then((d: any) => setRecentLogs(d.logs || []))
      .catch(() => setRecentLogs([]));
  }, []);

  // Map a log row's HTTP-style status code to a UI tone.
  const logTone = (status: number): "ok" | "warn" | "err" | "info" => {
    if (status >= 500) return "err";
    if (status === 402 || status === 401) return "warn";
    if (status >= 400) return "warn";
    if (status >= 200 && status < 300) return "ok";
    return "info";
  };

  const fmtRelative = (iso: string | null) => {
    if (!iso) return "";
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return "";
    const diff = Math.max(0, Date.now() - then) / 1000;
    if (diff < 60) return "agora";
    if (diff < 3600) return `há ${Math.floor(diff / 60)} min`;
    if (diff < 86400) return `há ${Math.floor(diff / 3600)} h`;
    return `há ${Math.floor(diff / 86400)} d`;
  };

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
        {/* Activity feeds */}
        <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Documentos Emitidos — latest 5 invoices */}
          <div className="glass p-6 rounded-[2.5rem] border-slate-800/40 flex flex-col overflow-hidden relative min-h-[280px]">
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-emerald-500/10 rounded-xl border border-emerald-500/20">
                  <FileText className="w-4 h-4 text-emerald-400" />
                </div>
                <h3 className="text-[11px] font-black text-slate-300 uppercase tracking-[0.18em]">Documentos Emitidos</h3>
              </div>
              <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Últimos 5</span>
            </div>

            {recentInvoices === null ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="w-6 h-6 border-2 border-slate-700 border-t-emerald-400 rounded-full animate-spin" />
              </div>
            ) : recentInvoices.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center gap-2 py-4">
                <Inbox className="w-8 h-8 text-slate-700" />
                <p className="text-xs text-slate-500 font-bold uppercase tracking-widest">Sem documentos</p>
                <p className="text-[10px] text-slate-600 max-w-[200px]">Aparecem aqui assim que o Rioko emitir a primeira fatura.</p>
              </div>
            ) : (
              <ul className="space-y-1.5 -mx-2">
                {recentInvoices.map((inv) => (
                  <li key={inv.order_id}>
                    {inv.ix_url ? (
                      <a
                        href={inv.ix_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl hover:bg-white/5 transition-all group"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-1 h-1 rounded-full bg-emerald-400 shrink-0" />
                          <div className="min-w-0">
                            <p className="text-xs font-bold text-slate-200 truncate">#{inv.order_id}</p>
                            <p className="text-[10px] text-slate-500 font-mono">IX {inv.invoice_id}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-[10px] text-slate-500 font-mono">{fmtRelative(inv.created_at)}</span>
                          <ExternalLink className="w-3 h-3 text-slate-600 group-hover:text-emerald-400 transition-colors" />
                        </div>
                      </a>
                    ) : (
                      <div className="flex items-center justify-between gap-3 px-3 py-2">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-1 h-1 rounded-full bg-slate-600 shrink-0" />
                          <div className="min-w-0">
                            <p className="text-xs font-bold text-slate-200 truncate">#{inv.order_id}</p>
                            <p className="text-[10px] text-slate-500 font-mono">IX {inv.invoice_id}</p>
                          </div>
                        </div>
                        <span className="text-[10px] text-slate-500 font-mono">{fmtRelative(inv.created_at)}</span>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Logs — latest 10 entries */}
          <div className="glass p-6 rounded-[2.5rem] border-slate-800/40 flex flex-col overflow-hidden relative min-h-[280px]">
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-sky-500/10 rounded-xl border border-sky-500/20">
                  <ScrollText className="w-4 h-4 text-sky-400" />
                </div>
                <h3 className="text-[11px] font-black text-slate-300 uppercase tracking-[0.18em]">Logs</h3>
              </div>
              <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Últimos 10</span>
            </div>

            {recentLogs === null ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="w-6 h-6 border-2 border-slate-700 border-t-sky-400 rounded-full animate-spin" />
              </div>
            ) : recentLogs.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center gap-2 py-4">
                <Inbox className="w-8 h-8 text-slate-700" />
                <p className="text-xs text-slate-500 font-bold uppercase tracking-widest">Sem logs</p>
                <p className="text-[10px] text-slate-600 max-w-[200px]">Quando chegarem webhooks, os eventos aparecem aqui.</p>
              </div>
            ) : (
              <ul className="space-y-1 -mx-2 max-h-[420px] overflow-y-auto scrollbar-hide">
                {recentLogs.map((log) => {
                  const tone = logTone(log.status);
                  const dot = tone === "ok" ? "bg-emerald-400"
                          : tone === "warn" ? "bg-amber-400"
                          : tone === "err" ? "bg-rose-500"
                          : "bg-slate-500";
                  return (
                    <li key={log.id} className="px-3 py-1.5 rounded-lg hover:bg-white/5 transition-colors">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={cn("w-1 h-1 rounded-full shrink-0", dot)} />
                          <span className="text-[10px] font-mono text-slate-400 truncate">{log.topic}</span>
                        </div>
                        <span className="text-[9px] font-mono text-slate-600 shrink-0">{fmtRelative(log.created_at)}</span>
                      </div>
                      {log.message && (
                        <p className="text-[10px] text-slate-500 truncate pl-3 mt-0.5" title={log.message}>{log.message}</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
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
