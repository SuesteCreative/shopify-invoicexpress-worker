"use client";

export const runtime = "edge";

import { motion } from "framer-motion";
import { useState, useEffect } from "react";
import { Check, Lock, ChevronRight, Store, CreditCard, Settings2, Loader2, Circle, HelpCircle, Info, XCircle, ShieldCheck, Webhook, AlertTriangle } from "lucide-react";
import Image from "next/image";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function Dashboard() {
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activating, setActivating] = useState(false);
  const [activeStatus, setActiveStatus] = useState<"idle" | "success" | "error">("idle");

  // Form State
  const [shopifyDomain, setShopifyDomain] = useState("");
  const [shopifyToken, setShopifyToken] = useState("");
  const [shopifyWebhookSecret, setShopifyWebhookSecret] = useState("");
  const [shopifyApiVersion, setShopifyApiVersion] = useState("2026-01");
  const [ixAccount, setIxAccount] = useState("");
  const [ixApiKey, setIxApiKey] = useState("");
  const [ixEnvironment, setIxEnvironment] = useState("production");
  const [vatIncluded, setVatIncluded] = useState(true);
  const [autoFinalize, setAutoFinalize] = useState(false);
  const [exemptionReason, setExemptionReason] = useState("M01");
  const [shopifyAuthorized, setShopifyAuthorized] = useState(false);
  const [ixAuthorized, setIxAuthorized] = useState(false);
  const [webhooksActive, setWebhooksActive] = useState(false);
  const [shopifyError, setShopifyError] = useState("");
  const [ixError, setIxError] = useState("");

  const exemptionOptions = [
    { value: "M01", label: "Artigo 16.º, n.º 6 do CIVA" },
    { value: "M02", label: "Artigo 6.º do Decreto-Lei n.º 198/90, de 19 de junho" },
    { value: "M04", label: "Isento artigo 13.º do CIVA" },
    { value: "M05", label: "Isento artigo 14.º do CIVA" },
    { value: "M06", label: "Isento artigo 15.º do CIVA" },
    { value: "M07", label: "Isento artigo 9.º do CIVA" },
    { value: "M08", label: "Simples: Não confere direito a dedução" },
    { value: "M09", label: "IVA – não confere direito a dedução" },
    { value: "M10", label: "Isento artigo 31.º do CIVA" },
    { value: "M11", label: "Regime especial de isenção artigo 53.º do CIVA" },
    { value: "M12", label: "Regime da margem de lucro – Agências de Viagens" },
    { value: "M13", label: "Regime da margem de lucro – Bens em segunda mão" },
    { value: "M14", label: "Regime da margem de lucro – Objetos de arte" },
    { value: "M15", label: "Regime da margem de lucro – Objetos de coleção e antiguidades" },
    { value: "M16", label: "Isento artigo 14.º do RITI" },
    { value: "M20", label: "IVA - autoliquidação" },
    { value: "M21", label: "IVA - autoliquidação (artigo 2.º, n.º 1, alínea i) do CIVA)" },
    { value: "M24", label: "IVA - autoliquidação (artigo 2.º, n.º 1, alínea m) do CIVA)" },
    { value: "M25", label: "IVA - autoliquidação (artigo 2.º, n.º 1, alínea j) do CIVA)" },
    { value: "M26", label: "IVA - autoliquidação (artigo 2.º, n.º 1, alínea l) do CIVA)" },
    { value: "M30", label: "IVA - inversão do sujeito passivo (artigo 6.º, n.º 6, alínea a) do CIVA)" },
    { value: "M31", label: "IVA - inversão do sujeito passivo (artigo 6.º, n.º 6, alínea b) do CIVA)" },
    { value: "M32", label: "IVA - inversão do sujeito passivo (artigo 6.º, n.º 6, alínea c) do CIVA)" },
    { value: "M33", label: "IVA - inversão do sujeito passivo (artigo 6.º, n.º 6, alínea e) do CIVA)" },
    { value: "M34", label: "IVA - inversão do sujeito passivo (artigo 6.º, n.º 6, alínea f) do CIVA)" },
    { value: "M35", label: "IVA - inversão do sujeito passivo (artigo 6.º, n.º 6, alínea g) do CIVA)" },
    { value: "M40", label: "IVA - autoliquidação (artigo 2.º, n.º 1, alínea n) do CIVA)" },
    { value: "M41", label: "IVA - autoliquidação (artigo 2.º, n.º 1, alínea p) do CIVA)" },
    { value: "M42", label: "IVA - autoliquidação (artigo 2.º, n.º 1, alínea q) do CIVA)" },
    { value: "M43", label: "IVA - autoliquidação (artigo 2.º, n.º 1, alínea r) do CIVA)" },
    { value: "M99", label: "Não sujeito; não tributado (ou similar)" },
  ];

  // Load existing data
  useEffect(() => {
    // Sync user data first
    fetch("/api/auth/sync", { method: "POST" }).catch(console.error);

    fetch("/api/integrations")
      .then(res => res.json())
      .then((data: any) => {
        if (data.shopify_domain) setShopifyDomain(data.shopify_domain);
        if (data.shopify_token) setShopifyToken(data.shopify_token);
        if (data.shopify_webhook_secret) setShopifyWebhookSecret(data.shopify_webhook_secret);
        if (data.shopify_api_version) setShopifyApiVersion(data.shopify_api_version);
        if (data.ix_account_name) setIxAccount(data.ix_account_name);
        if (data.ix_api_key) setIxApiKey(data.ix_api_key);
        if (data.ix_environment) setIxEnvironment(data.ix_environment);
        if (data.ix_exemption_reason) setExemptionReason(data.ix_exemption_reason);
        if (data.vat_included !== undefined) setVatIncluded(data.vat_included === 1);
        if (data.auto_finalize !== undefined) setAutoFinalize(data.auto_finalize === 1);
        if (data.shopify_authorized !== undefined) setShopifyAuthorized(data.shopify_authorized === 1);
        if (data.ix_authorized !== undefined) setIxAuthorized(data.ix_authorized === 1);
        if (data.webhooks_active !== undefined) setWebhooksActive(data.webhooks_active === 1);
        if (data.shopify_error) setShopifyError(data.shopify_error);
        if (data.ix_error) setIxError(data.ix_error);

        // Determine current step based on completed data
        if (data.ix_api_key && data.shopify_token) setStep(3);
        else if (data.shopify_token) setStep(2);
        else setStep(1);
      })
      .finally(() => setLoading(false));
  }, []);

  const handleConnect = async () => {
    // Basic validation: Prevent empty submissions
    if (step === 1 && (!shopifyDomain || !shopifyToken)) return;
    if (step === 2 && (!ixAccount || !ixApiKey)) return;

    setSaving(true);
    try {
      const response = await fetch("/api/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopify_domain: shopifyDomain,
          shopify_token: shopifyToken,
          shopify_webhook_secret: shopifyWebhookSecret,
          shopify_api_version: shopifyApiVersion,
          ix_account_name: ixAccount,
          ix_api_key: ixApiKey,
          ix_environment: ixEnvironment,
          ix_exemption_reason: exemptionReason,
          vat_included: vatIncluded,
          auto_finalize: autoFinalize
        })
      });

      if (response.ok) {
        // Run validation for the current step
        const type = step === 1 ? "shopify" : (step === 2 ? "ix" : null);
        if (type) {
          const valRes = await fetch("/api/integrations/validate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type })
          });
          const valData = await valRes.json() as any;
          if (type === "shopify") {
            setShopifyAuthorized(valData.isValid);
            setShopifyError(valData.error || "");
          }
          if (type === "ix") {
            setIxAuthorized(valData.isValid);
            setIxError(valData.error || "");
          }
        }

        if (step < 3) setStep(step + 1);
      } else {
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
          const data = await response.json() as any;
          alert(`Error: ${data.error || "Failed to save integration"}`);
        } else {
          const text = await response.text();
          alert(`Server Error (${response.status}): ${text || "Please check your Clerk session or Cloudflare environment variables."}`);
        }
      }
    } catch (error: any) {
      console.error("Save error:", error);
      alert(`Network Error: ${error.message || "Please check your connection"}`);
    } finally {
      setSaving(false);
    }
  };

  const handleActivate = async () => {
    // Pro-tip: Always save the latest config (toggles) before activating
    await handleConnect();

    setActivating(true);
    setActiveStatus("idle");
    try {
      const response = await fetch("/api/integrations/activate", { method: "POST" });
      if (response.ok) setActiveStatus("success");
      else setActiveStatus("error");
    } catch (error) {
      setActiveStatus("error");
    } finally {
      setActivating(false);
    }
  };

  const steps = [
    {
      id: 1,
      title: "Passo 1: Ligação Shopify",
      description: "Ligue a sua loja para iniciar o processo de integração.",
      icon: Store,
      logo: "/images/shopify-logo.webp",
      logoWidth: 80, // Reduced from 100
      fields: [
        { label: "Domínio Shopify (.myshopify.com)", value: shopifyDomain, setter: setShopifyDomain, placeholder: "exemplo.myshopify.com", type: "text" },
        { label: "Admin API Access Token", value: shopifyToken, setter: setShopifyToken, placeholder: "shpat_xxxxxxxxxxxxxxxx", type: "password" },
        { label: "Webhook Signing Secret", value: shopifyWebhookSecret, setter: setShopifyWebhookSecret, placeholder: "Ver Shopify Notifications > Webhooks", type: "password" },
        { label: "Versão da API", value: shopifyApiVersion, setter: setShopifyApiVersion, placeholder: "2026-01", type: "text" }
      ]
    },
    {
      id: 2,
      title: "Passo 2: Conexão InvoiceXpress",
      description: "Introduza os detalhes da sua conta para ligar as finanças.",
      icon: CreditCard,
      logo: "/images/invoicexpress_logo2.png",
      logoWidth: 100, // Adjusted for balance
      fields: [
        { label: "Nome da Conta", value: ixAccount, setter: setIxAccount, placeholder: "ultramegasonico", type: "text" },
        { label: "Chave API", value: ixApiKey, setter: setIxApiKey, placeholder: "••••••••••••••••••••••••", type: "password" },
        { label: "Ambiente", value: ixEnvironment, setter: setIxEnvironment, placeholder: "Insira 'production' ou 'sandbox'", type: "text" }
      ]
    },
    {
      id: 3,
      title: "Passo 3: Definições de Integração",
      description: "Defina as regras, impostos e níveis de finalização.",
      icon: Settings2,
      isConfig: true
    }
  ];

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 className="w-12 h-12 text-accent-blue animate-spin opacity-50" />
      </div>
    );
  }

  return (
    <div className="space-y-12 animate-in fade-in duration-1000 slide-in-from-bottom-4">

      {/* Welcome Message */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-8">
        <div className="space-y-2">
          <h1 className="text-5xl font-black tracking-tight bg-gradient-to-r from-white via-white to-slate-500 bg-clip-text text-transparent">Olá, Pedro</h1>
          <p className="text-slate-400 font-semibold tracking-wide flex items-center gap-2">
            Rioko 2.0 está a postos <span className="w-1 h-1 rounded-full bg-slate-600" /> A sua automação está ativa.
          </p>
        </div>
        <div className="flex items-center gap-5 glass px-5 py-3 rounded-2xl border-slate-800/50">
          <div className="flex -space-x-2.5">
            <div className="h-9 w-9 rounded-full ring-4 ring-slate-950 bg-emerald-500/10 flex items-center justify-center border border-emerald-500/30">
              <Store className="w-4.5 h-4.5 text-emerald-400" />
            </div>
            <div className="h-9 w-9 rounded-full ring-4 ring-slate-950 bg-blue-500/10 flex items-center justify-center border border-blue-500/30">
              <CreditCard className="w-4.5 h-4.5 text-blue-400" />
            </div>
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">Estado da Sincronização</span>
            <span className={cn(
              "text-xs font-bold flex items-center gap-1.5",
              activeStatus === "success" ? "text-emerald-400" : "text-slate-500 animate-pulse"
            )}>
              <span className={cn("w-1.5 h-1.5 rounded-full", activeStatus === "success" ? "bg-emerald-400 animate-pulse" : "bg-slate-700")} />
              {activeStatus === "success" ? "Tempo Real ATIVO" : "A aguardar ligação..."}
            </span>
          </div>
        </div>
      </div>

      {/* The Set-up Bars */}
      <div className="grid gap-8">
        {steps.map((s) => {
          const isActive = step === s.id && !(s.id === 3 && activeStatus === "success");
          const isComplete = step > s.id || (s.id === 3 && activeStatus === "success");
          const isLocked = step < s.id;
          const Icon = s.icon;

          const isAuthorized = s.id === 1 ? shopifyAuthorized : (s.id === 2 ? ixAuthorized : true);
          const errorMsg = s.id === 1 ? shopifyError : (s.id === 2 ? ixError : "");

          return (
            <motion.div
              key={s.id}
              initial={false}
              animate={{
                scale: isActive ? 1.01 : 1,
                opacity: isLocked ? 0.35 : 1,
                y: isActive ? -4 : 0
              }}
              className={cn(
                "glass rounded-[2rem] overflow-visible relative group transition-all duration-700",
                isActive && "border-accent-blue/40 shadow-[0_20px_50px_rgba(0,0,0,0.5),0_0_30px_rgba(56,189,248,0.1)]",
                isComplete && isAuthorized && "border-emerald-500/30 bg-emerald-500/[0.02]",
                isComplete && !isAuthorized && "border-amber-500/30 bg-amber-500/[0.02]",
                isLocked && "grayscale scale-[0.98] !overflow-hidden"
              )}
            >
              <div className="p-10 flex flex-col lg:flex-row items-start lg:items-center gap-10">
                <div className={cn(
                  "w-20 h-20 rounded-2xl flex items-center justify-center transition-all duration-700 shrink-0 shadow-inner p-1",
                  isActive ? "bg-accent-blue/20 text-accent-blue ring-1 ring-accent-blue/30" :
                    isComplete ? (isAuthorized ? "bg-emerald-500/20 text-emerald-500 ring-1 ring-emerald-500/30" : "bg-amber-500/10 text-amber-500 ring-1 ring-amber-500/30") :
                      "bg-slate-900/50 text-slate-700 ring-1 ring-slate-800"
                )}>
                  {isComplete ? (
                    isAuthorized ? <Check className="w-10 h-10 stroke-[3]" /> : <Circle className="w-10 h-10 stroke-[4] text-amber-500" />
                  ) : (
                    isLocked ? <Lock className="w-8 h-8 opacity-30" /> : <Icon className="w-10 h-10 stroke-[1.5]" />
                  )}
                </div>

                <div className="flex-1 space-y-2">
                  <div className="flex items-center gap-4">
                    <h2 className="text-2xl font-bold tracking-tight">{s.title}</h2>
                    {isComplete && (
                      <div className="relative group/badge">
                        <span className={cn(
                          "px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-[0.15em] border flex items-center gap-2 transition-all",
                          isAuthorized
                            ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20"
                            : "bg-amber-500/10 text-amber-500 border-amber-500/20"
                        )}>
                          {isAuthorized ? "Autorizado" : "Pendente"}
                          {!isAuthorized && <HelpCircle className="w-3 h-3 animate-pulse cursor-help" />}
                        </span>

                        {!isAuthorized && errorMsg && (
                          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-8 w-80 p-6 bg-slate-900 border-2 border-amber-500/20 rounded-[2rem] shadow-[0_20px_60px_rgba(0,0,0,0.9)] opacity-0 group-hover/badge:opacity-100 transition-all pointer-events-none z-[100] scale-90 group-hover/badge:scale-100 backdrop-blur-3xl">
                            <div className="flex items-center gap-3 mb-4 text-amber-400">
                              <div className="bg-amber-400/10 p-2 rounded-xl ring-1 ring-amber-400/20">
                                <Info className="w-5 h-5" />
                              </div>
                              <div className="flex flex-col">
                                <p className="text-[10px] font-black uppercase tracking-[0.2em] leading-none">Diagnóstico de Ligação</p>
                                <p className="text-[9px] font-bold text-amber-500/60 uppercase mt-1">Rioko 2.0 Engine</p>
                              </div>
                            </div>
                            <div className="bg-black/40 rounded-[1.25rem] p-4 border border-white/5">
                              <p className="text-[13px] text-amber-50/90 font-bold leading-relaxed">{errorMsg}</p>
                            </div>
                            <div className="absolute -bottom-2.5 left-1/2 -translate-x-1/2 w-5 h-5 bg-slate-900 rotate-45 border-r-2 border-b-2 border-amber-500/10" />
                          </div>
                        )}
                      </div>
                    )}
                    {isActive && <div className="h-1.5 w-1.5 rounded-full bg-accent-blue animate-ping" />}
                  </div>
                  <p className="text-slate-400 font-medium leading-relaxed max-w-xl">{s.description}</p>
                </div>

                <div className="flex items-center gap-10 w-full lg:w-auto">
                  {s.logo && (
                    <div className={cn(
                      "hidden xl:block transition-all duration-700",
                      isActive ? "opacity-100 grayscale-0" : "opacity-20 grayscale"
                    )}>
                      <Image src={s.logo} alt={s.title} width={s.logoWidth} height={40} className="object-contain" />
                    </div>
                  )}

                  {isActive && (
                    <div className="flex items-center gap-4 ml-auto">
                      {step > 1 && (
                        <button
                          onClick={() => setStep(step - 1)}
                          className="text-slate-500 hover:text-white text-[10px] font-black uppercase tracking-widest transition-all px-4"
                        >
                          Voltar
                        </button>
                      )}
                      <button
                        onClick={handleConnect}
                        disabled={saving || (s.id === 1 && (!shopifyDomain || !shopifyToken)) || (s.id === 2 && (!ixAccount || !ixApiKey))}
                        className="bg-white text-black px-8 py-3.5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center gap-3 hover:bg-accent-blue hover:text-white transition-all duration-500 transform active:scale-95 group shadow-xl shadow-white/5 disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed"
                      >
                        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : (s.id === 3 ? "Guardar Regras" : "Ligar")}
                        {!saving && <ChevronRight className="w-4 h-4 group-hover:translate-x-1.5 transition-transform" />}
                      </button>
                    </div>
                  )}

                  {isComplete && (
                    <button
                      onClick={() => setStep(s.id)}
                      className="ml-auto bg-slate-800/50 hover:bg-slate-800 text-slate-300 px-5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all border border-slate-700/50"
                    >
                      Atualizar
                    </button>
                  )}
                </div>
              </div>

              <motion.div
                animate={{ height: (isActive && activeStatus !== "success") ? 'auto' : 0 }}
                className="overflow-hidden bg-slate-950/40 border-t border-slate-800/30"
              >
                {isActive && activeStatus !== "success" && (
                  <div className="p-10 pt-8 grid md:grid-cols-2 gap-8 animate-in zoom-in-95 duration-700">
                    {s.isConfig ? (
                      <>
                        <div className="glass p-6 rounded-2xl flex items-center justify-between border-slate-800/50">
                          <div>
                            <h3 className="font-bold text-sm">IVA Incluído</h3>
                            <p className="text-[10px] text-slate-500 font-medium mt-1 uppercase tracking-wider">Os preços no Shopify já incluem IVA</p>
                          </div>
                          <button
                            onClick={() => setVatIncluded(!vatIncluded)}
                            className={cn(
                              "w-12 h-6 rounded-full transition-all duration-500 relative ring-1 ring-inset ring-black/20",
                              vatIncluded ? "bg-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.3)]" : "bg-slate-800"
                            )}
                          >
                            <div className={cn("absolute top-1 w-4 h-4 rounded-full bg-white transition-all duration-500 shadow-sm", vatIncluded ? "left-7" : "left-1")} />
                          </button>
                        </div>
                        <div className="glass p-6 rounded-2xl flex items-center justify-between border-slate-800/50">
                          <div>
                            <h3 className="font-bold text-sm">Auto Finalizar</h3>
                            <p className="text-[10px] text-slate-500 font-medium mt-1 uppercase tracking-wider">Emitir e finalizar documentos imediatamente</p>
                          </div>
                          <button
                            onClick={() => setAutoFinalize(!autoFinalize)}
                            className={cn(
                              "w-12 h-6 rounded-full transition-all duration-500 relative ring-1 ring-inset ring-black/20",
                              autoFinalize ? "bg-accent-blue shadow-[0_0_15px_rgba(56,189,248,0.3)]" : "bg-slate-800"
                            )}
                          >
                            <div className={cn("absolute top-1 w-4 h-4 rounded-full bg-white transition-all duration-500 shadow-sm", autoFinalize ? "left-7" : "left-1")} />
                          </button>
                        </div>
                        <div className="md:col-span-2 glass p-8 rounded-[2rem] border-slate-800/50 space-y-4">
                          <div className="flex items-center gap-3 mb-2">
                            <div className="p-2 bg-amber-500/10 rounded-xl">
                              <Info className="w-4 h-4 text-amber-500" />
                            </div>
                            <h3 className="font-bold text-sm tracking-tight">Razão de Isenção (IVA 0%)</h3>
                          </div>
                          <p className="text-[10px] text-slate-500 font-medium uppercase tracking-wider leading-relaxed">
                            Se algum artigo na Shopify tiver 0% de IVA, esta será a razão de isenção aplicada automaticamente na fatura.
                          </p>
                          <div className="relative pt-2">
                            <select
                              value={exemptionReason}
                              onChange={(e) => setExemptionReason(e.target.value)}
                              className="w-full bg-slate-900/80 border border-slate-800 rounded-2xl px-6 py-4 text-sm font-bold focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 outline-none transition-all appearance-none cursor-pointer pr-12 text-slate-200"
                            >
                              {exemptionOptions.map((opt) => (
                                <option key={opt.value} value={opt.value} className="bg-slate-900 py-2">
                                  {opt.value} - {opt.label}
                                </option>
                              ))}
                            </select>
                            <div className="absolute right-6 top-[55%] -translate-y-1/2 pointer-events-none opacity-40">
                              <ChevronRight className="w-5 h-5 rotate-90 text-amber-500" />
                            </div>
                          </div>
                        </div>
                        <div className="md:col-span-2 pt-4">
                          <button
                            onClick={handleActivate}
                            disabled={activating}
                            className={cn(
                              "w-full py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl",
                              activeStatus === "error" ? "bg-rose-500 text-white" : "bg-white text-black hover:bg-slate-100"
                            )}
                          >
                            {activating ? <Loader2 className="w-5 h-5 animate-spin" /> :
                              activeStatus === "error" ? "Tentar Ativação novamente" : "Guardar & Ativar Webhooks"}
                          </button>
                        </div>
                      </>
                    ) : (
                      s.fields?.map((f, i) => (
                        <div key={i} className="space-y-3">
                          <label className="text-[10px] text-slate-500 font-black uppercase tracking-[0.2em] ml-1 flex items-center gap-2">
                            <span className="w-1 h-1 rounded-full bg-accent-blue" />
                            {f.label}
                          </label>
                          <input
                            type={f.type}
                            value={f.value}
                            onChange={(e) => f.setter(e.target.value)}
                            placeholder={f.placeholder}
                            className="w-full bg-slate-950/50 border border-slate-800/80 rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent-blue/20 focus:border-accent-blue outline-none transition-all placeholder:text-slate-800"
                          />
                        </div>
                      ))
                    )}
                  </div>
                )
                }
              </motion.div>
            </motion.div>
          );
        })}

        {/* Passo 4: Integration Status Bar */}
        {
          (activeStatus === "success" || step === 3) && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className={cn(
                "rounded-[2.5rem] p-1 shadow-2xl transition-all duration-1000",
                (shopifyAuthorized && ixAuthorized && webhooksActive)
                  ? "bg-gradient-to-r from-emerald-500/40 via-emerald-400/10 to-emerald-500/40 shadow-[0_0_50px_rgba(16,185,129,0.2)]"
                  : "bg-gradient-to-r from-amber-500/40 via-amber-400/10 to-amber-500/40 shadow-[0_0_50px_rgba(245,158,11,0.2)]"
              )}
            >
              <div className="bg-slate-950 rounded-[2.3rem] p-10 flex flex-col gap-8 border border-white/5">
                {/* Top Row: Main Status */}
                <div className="flex flex-col md:flex-row items-center justify-between gap-8">
                  <div className="flex items-center gap-8">
                    <div className={cn(
                      "w-20 h-20 rounded-[1.8rem] flex items-center justify-center p-0.5",
                      (shopifyAuthorized && ixAuthorized && webhooksActive)
                        ? "bg-emerald-500/20 ring-2 ring-emerald-400 ring-offset-4 ring-offset-slate-950"
                        : "bg-amber-500/10 ring-2 ring-amber-400 ring-offset-4 ring-offset-slate-950"
                    )}>
                      {(shopifyAuthorized && ixAuthorized && webhooksActive) ? (
                        <ShieldCheck className="w-10 h-10 text-emerald-400" />
                      ) : (
                        <Circle className="w-10 h-10 text-amber-500 stroke-[3]" />
                      )}
                    </div>
                    <div className="space-y-1">
                      <h3 className="text-2xl font-black tracking-tight">
                        {(shopifyAuthorized && ixAuthorized && webhooksActive) ? "Integração Concluída" : "Integração Incompleta"}
                      </h3>
                      <p className="text-slate-500 font-bold uppercase tracking-widest text-[10px]">
                        {(shopifyAuthorized && ixAuthorized && webhooksActive)
                          ? "A sua conta está configurada e protegida no Rioko 2.0"
                          : "Corrija os campos assinalados abaixo para ativar a sincronização"}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className={cn(
                      "px-6 py-3 rounded-2xl font-black text-[10px] uppercase tracking-[0.2em] border transition-all duration-1000",
                      (shopifyAuthorized && ixAuthorized && webhooksActive)
                        ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                        : "bg-amber-500/10 text-amber-500 border-amber-500/30"
                    )}>
                      {(shopifyAuthorized && ixAuthorized && webhooksActive) ? "ONLINE • REAL-TIME" : "PENDENTE • REQUER AÇÃO"}
                    </div>
                  </div>
                </div>

                {/* Diagnostic Row */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 border-t border-white/5 pt-8">
                  {/* Shopify Status */}
                  <div className={cn(
                    "flex items-center gap-3 px-5 py-4 rounded-2xl border",
                    shopifyAuthorized ? "bg-emerald-500/5 border-emerald-500/20" : "bg-amber-500/5 border-amber-500/20"
                  )}>
                    <div className={cn("w-8 h-8 rounded-xl flex items-center justify-center shrink-0", shopifyAuthorized ? "bg-emerald-500/10" : "bg-amber-500/10")}>
                      <Store className={cn("w-4 h-4", shopifyAuthorized ? "text-emerald-400" : "text-amber-500")} />
                    </div>
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">Shopify</p>
                      <p className={cn("text-xs font-bold", shopifyAuthorized ? "text-emerald-400" : "text-amber-500")}>
                        {shopifyAuthorized ? "Autorizado" : "Pendente"}
                      </p>
                    </div>
                    {shopifyAuthorized ? <Check className="w-4 h-4 text-emerald-400 ml-auto" /> : <AlertTriangle className="w-4 h-4 text-amber-500 ml-auto" />}
                  </div>

                  {/* InvoiceXpress Status */}
                  <div className={cn(
                    "flex items-center gap-3 px-5 py-4 rounded-2xl border",
                    ixAuthorized ? "bg-emerald-500/5 border-emerald-500/20" : "bg-amber-500/5 border-amber-500/20"
                  )}>
                    <div className={cn("w-8 h-8 rounded-xl flex items-center justify-center shrink-0", ixAuthorized ? "bg-emerald-500/10" : "bg-amber-500/10")}>
                      <CreditCard className={cn("w-4 h-4", ixAuthorized ? "text-emerald-400" : "text-amber-500")} />
                    </div>
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">InvoiceXpress</p>
                      <p className={cn("text-xs font-bold", ixAuthorized ? "text-emerald-400" : "text-amber-500")}>
                        {ixAuthorized ? "Autorizado" : "Pendente"}
                      </p>
                    </div>
                    {ixAuthorized ? <Check className="w-4 h-4 text-emerald-400 ml-auto" /> : <AlertTriangle className="w-4 h-4 text-amber-500 ml-auto" />}
                  </div>

                  {/* Webhooks Status */}
                  <div className={cn(
                    "flex items-center gap-3 px-5 py-4 rounded-2xl border",
                    webhooksActive ? "bg-emerald-500/5 border-emerald-500/20" : "bg-rose-500/5 border-rose-500/20"
                  )}>
                    <div className={cn("w-8 h-8 rounded-xl flex items-center justify-center shrink-0", webhooksActive ? "bg-emerald-500/10" : "bg-rose-500/10")}>
                      <Webhook className={cn("w-4 h-4", webhooksActive ? "text-emerald-400" : "text-rose-400")} />
                    </div>
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">Webhooks Shopify</p>
                      <p className={cn("text-xs font-bold", webhooksActive ? "text-emerald-400" : "text-rose-400")}>
                        {webhooksActive ? "Registados" : "Não Instalados"}
                      </p>
                    </div>
                    {webhooksActive ? <Check className="w-4 h-4 text-emerald-400 ml-auto" /> : <AlertTriangle className="w-4 h-4 text-rose-400 ml-auto animate-pulse" />}
                  </div>
                </div>

                {/* Warning Banner if webhooks missing */}
                {!webhooksActive && (
                  <div className="flex items-start gap-4 bg-rose-500/5 border border-rose-500/20 rounded-2xl px-6 py-4">
                    <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-bold text-rose-300">Webhooks não instalados na Shopify</p>
                      <p className="text-[11px] text-slate-400 mt-1">
                        Clica em &quot;Guardar &amp; Ativar Webhooks&quot; no Passo 3 para registar os webhooks automaticamente. Se o erro persistir, verifica se o token Shopify tem permissão para gerir webhooks (<code className="text-rose-300">write_webhooks</code>).
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          )
        }
      </div >

      <div className="pt-12 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-900 border border-slate-800">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">D1 DATABASE LIGADA</span>
        </div>
      </div>
    </div >
  );
}
