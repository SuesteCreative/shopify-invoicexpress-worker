"use client";

export const runtime = "edge";

import { motion } from "framer-motion";
import { useState, useEffect } from "react";
import { Check, Lock, ChevronRight, Store, CreditCard, Settings2, Loader2, Circle, HelpCircle, Info, ShieldCheck, Webhook, AlertTriangle, Zap } from "lucide-react";
import Image from "next/image";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { useUser } from "@clerk/nextjs";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function Dashboard() {
  const { user: clerkUser } = useUser();
  const firstName = clerkUser?.firstName || clerkUser?.fullName?.split(" ")[0] || "";
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activating, setActivating] = useState(false);
  const [webhookStatus, setWebhookStatus] = useState<"idle" | "success" | "error">("idle");

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

  // Validation State
  const [shopifyAuthorized, setShopifyAuthorized] = useState(false);
  const [webhooksActive, setWebhooksActive] = useState(false);
  const [ixAuthorized, setIxAuthorized] = useState(false);
  const [shopifyError, setShopifyError] = useState("");
  const [ixError, setIxError] = useState("");

  // allComplete: all 3 integrations are validated
  // webhooksActive can be "unknown" when token lacks read_webhooks, so we also
  // allow completion if both Shopify and IX are authorized AND we're on step 4+
  const allComplete = shopifyAuthorized && ixAuthorized && (webhooksActive || step >= 4);

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

        // Smart step resume — always start from the furthest valid state
        if (data.shopify_authorized && data.ix_authorized && data.ix_api_key) setStep(5);
        else if (data.ix_api_key && data.shopify_token) setStep(4);
        else if (data.webhooks_active) setStep(3);
        else if (data.shopify_token) setStep(2);
        else setStep(1);
      })
      .finally(() => setLoading(false));
  }, []);

  // --- Step 1: Save Shopify credentials & validate ---
  const handleShopifyConnect = async () => {
    if (!shopifyDomain || !shopifyToken) return;
    setSaving(true);
    try {
      const saveRes = await fetch("/api/integrations", {
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
      if (!saveRes.ok) { alert("Erro ao guardar. Tenta novamente."); return; }

      const valRes = await fetch("/api/integrations/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "shopify" })
      });
      const valData = await valRes.json() as any;
      setShopifyAuthorized(valData.isValid);
      setShopifyError(valData.error || "");
      // Preserve webhooksActive from validate (it reflects current DB state)
      if (valData.webhooks_active !== undefined) setWebhooksActive(valData.webhooks_active === 1);

      // Always advance to step 2 — validation status shown as badge
      setStep(2);
    } catch (e: any) {
      alert(`Erro de rede: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  // --- Step 2: Install webhooks & verify ---
  const handleWebhooksInstall = async () => {
    if (!shopifyWebhookSecret) return;
    setSaving(true);
    setActivating(true);
    setWebhookStatus("idle");
    try {
      // Save the webhook secret first
      await fetch("/api/integrations", {
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

      // Install webhooks
      const actRes = await fetch("/api/integrations/activate", { method: "POST" });
      if (actRes.ok) {
        setWebhookStatus("success");
        setWebhooksActive(true);
        setStep(3);
      } else {
        setWebhookStatus("error");
      }
    } catch {
      setWebhookStatus("error");
    } finally {
      setSaving(false);
      setActivating(false);
    }
  };

  // --- Step 2b: Manually confirm webhooks were installed ---
  const handleWebhooksConfirm = async () => {
    if (!shopifyWebhookSecret) return;
    setSaving(true);
    try {
      // Save the secret
      await fetch("/api/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopify_domain: shopifyDomain, shopify_token: shopifyToken,
          shopify_webhook_secret: shopifyWebhookSecret, shopify_api_version: shopifyApiVersion,
          ix_account_name: ixAccount, ix_api_key: ixApiKey, ix_environment: ixEnvironment,
          ix_exemption_reason: exemptionReason, vat_included: vatIncluded, auto_finalize: autoFinalize
        })
      });
      // Mark webhooks as confirmed in DB
      const confirmRes = await fetch("/api/integrations/webhooks-confirm", { method: "POST" });
      if (confirmRes.ok) {
        setWebhooksActive(true);
        setWebhookStatus("success");
        setStep(3);
      } else {
        alert("Erro ao confirmar. Tenta novamente.");
      }
    } catch (e: any) {
      alert(`Erro de rede: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  // --- Step 3: Save IX credentials & validate ---
  const handleIxConnect = async () => {
    if (!ixAccount || !ixApiKey) return;
    setSaving(true);
    try {
      const saveRes = await fetch("/api/integrations", {
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
      if (!saveRes.ok) { alert("Erro ao guardar. Tenta novamente."); return; }

      const valRes = await fetch("/api/integrations/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "ix" })
      });
      const valData = await valRes.json() as any;
      setIxAuthorized(valData.isValid);
      setIxError(valData.error || "");

      if (valData.isValid) setStep(4);
    } catch (e: any) {
      alert(`Erro de rede: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  // --- Step 4: Save settings ---
  const handleSaveSettings = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/integrations", {
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
      if (res.ok) {
        // Seal step 4 — moves it to "complete" state
        setStep(5);
      } else {
        alert("Erro ao guardar definições. Tenta novamente.");
      }
    } catch (e: any) {
      alert(`Erro ao guardar: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 className="w-12 h-12 text-accent-blue animate-spin opacity-50" />
      </div>
    );
  }

  // ── Helper: status badge for completed steps ──
  const StatusBadge = ({ isAuthorized, errorMsg }: { isAuthorized: boolean; errorMsg?: string }) => (
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
  );

  // ── Step definitions ──
  const steps = [
    {
      id: 1,
      title: "Passo 1: Ligação Shopify",
      description: "Conecte a sua loja Shopify através das credenciais de API.",
      icon: Store,
      logo: "/images/shopify-logo.webp",
      logoWidth: 80,
      isAuthorized: shopifyAuthorized,
      errorMsg: shopifyError,
      fields: [
        { label: "Domínio Shopify (.myshopify.com)", value: shopifyDomain, setter: setShopifyDomain, placeholder: "exemplo.myshopify.com", type: "text" },
        { label: "Admin API Access Token", value: shopifyToken, setter: setShopifyToken, placeholder: "shpat_xxxxxxxxxxxxxxxx", type: "password" },
        { label: "Versão da API", value: shopifyApiVersion, setter: setShopifyApiVersion, placeholder: "2026-01", type: "text" }
      ],
      action: handleShopifyConnect,
      actionLabel: "Verificar Ligação",
      isDisabled: !shopifyDomain || !shopifyToken,
    },
    {
      id: 2,
      title: "Passo 2: Criação de Webhooks",
      description: "Instale os webhooks para que o Rioko receba as encomendas automaticamente.",
      icon: Webhook,
      logo: "/images/shopify-logo.webp",
      logoWidth: 80,
      isAuthorized: webhooksActive,
      errorMsg: webhookStatus === "error" ? "Falha ao instalar webhooks. Verifica se o token tem permissão write_webhooks." : "",
      fields: [
        { label: "Webhook Signing Secret", value: shopifyWebhookSecret, setter: setShopifyWebhookSecret, placeholder: "Ver Shopify Notificações > Webhooks", type: "password" }
      ],
      action: handleWebhooksInstall,
      actionLabel: webhookStatus === "error" ? "Tentar novamente" : "Instalar Webhooks",
      isDisabled: !shopifyWebhookSecret,
      isWebhookStep: true,
    },
    {
      id: 3,
      title: "Passo 3: Conexão InvoiceXpress",
      description: "Introduza os detalhes da sua conta InvoiceXpress para ligar as finanças.",
      icon: CreditCard,
      logo: "/images/invoicexpress_logo2.png",
      logoWidth: 100,
      isAuthorized: ixAuthorized,
      errorMsg: ixError,
      fields: [
        { label: "Nome da Conta", value: ixAccount, setter: setIxAccount, placeholder: "ultramegasonico", type: "text" },
        { label: "Chave API", value: ixApiKey, setter: setIxApiKey, placeholder: "••••••••••••••••••••••••", type: "password" },
        { label: "Ambiente", value: ixEnvironment, setter: setIxEnvironment, placeholder: "Insira 'production' ou 'sandbox'", type: "text" }
      ],
      action: handleIxConnect,
      actionLabel: "Verificar Ligação",
      isDisabled: !ixAccount || !ixApiKey,
    },
    {
      id: 4,
      title: "Passo 4: Definições de Integração",
      description: "Defina as regras fiscais e o comportamento da emissão de documentos.",
      icon: Settings2,
      isAuthorized: true,
      errorMsg: "",
      isConfig: true,
      action: handleSaveSettings,
      actionLabel: "Guardar",
      isDisabled: false,
    }
  ];

  return (
    <div className="space-y-12 animate-in fade-in duration-1000 slide-in-from-bottom-4">

      {/* Welcome Message */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-8">
        <div className="space-y-2">
          <h1 className="text-5xl font-black tracking-tight bg-gradient-to-r from-white via-white to-slate-500 bg-clip-text text-transparent">
            {firstName ? `Olá, ${firstName}` : "Olá"}
          </h1>
          <p className="text-slate-400 font-semibold tracking-wide flex items-center gap-2">
            Rioko 2.0 está a postos <span className="w-1 h-1 rounded-full bg-slate-600" /> A sua automação está ativa.
          </p>
        </div>
        <div className="flex items-center gap-5 glass px-5 py-3 rounded-2xl border-slate-800/50">
          <div className="flex -space-x-2.5">
            <div className={cn("h-9 w-9 rounded-full ring-4 ring-slate-950 flex items-center justify-center border", shopifyAuthorized ? "bg-emerald-500/10 border-emerald-500/30" : "bg-slate-800/50 border-slate-700/30")}>
              <Store className={cn("w-4 h-4", shopifyAuthorized ? "text-emerald-400" : "text-slate-600")} />
            </div>
            <div className={cn("h-9 w-9 rounded-full ring-4 ring-slate-950 flex items-center justify-center border", webhooksActive ? "bg-violet-500/10 border-violet-500/30" : "bg-slate-800/50 border-slate-700/30")}>
              <Webhook className={cn("w-4 h-4", webhooksActive ? "text-violet-400" : "text-slate-600")} />
            </div>
            <div className={cn("h-9 w-9 rounded-full ring-4 ring-slate-950 flex items-center justify-center border", ixAuthorized ? "bg-blue-500/10 border-blue-500/30" : "bg-slate-800/50 border-slate-700/30")}>
              <CreditCard className={cn("w-4 h-4", ixAuthorized ? "text-blue-400" : "text-slate-600")} />
            </div>
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">Estado da Sincronização</span>
            <span className={cn(
              "text-xs font-bold flex items-center gap-1.5",
              allComplete ? "text-emerald-400" : "text-slate-500 animate-pulse"
            )}>
              <span className={cn("w-1.5 h-1.5 rounded-full", allComplete ? "bg-emerald-400 animate-pulse" : "bg-slate-700")} />
              {allComplete ? "Tempo Real ATIVO" : "A aguardar ligação..."}
            </span>
          </div>
        </div>
      </div>

      {/* The Set-up Bars */}
      <div className="grid gap-8">
        {steps.map((s) => {
          const isActive = step === s.id;
          const isComplete = step > s.id;
          const isLocked = step < s.id;
          const Icon = s.icon;

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
                isComplete && s.isAuthorized && "border-emerald-500/30 bg-emerald-500/[0.02]",
                isComplete && !s.isAuthorized && "border-amber-500/30 bg-amber-500/[0.02]",
                isLocked && "grayscale scale-[0.98] !overflow-hidden"
              )}
            >
              <div className="p-10 flex flex-col lg:flex-row items-start lg:items-center gap-10">
                {/* Step Icon */}
                <div className={cn(
                  "w-20 h-20 rounded-2xl flex items-center justify-center transition-all duration-700 shrink-0 shadow-inner p-1",
                  isActive ? "bg-accent-blue/20 text-accent-blue ring-1 ring-accent-blue/30" :
                    isComplete ? (s.isAuthorized ? "bg-emerald-500/20 text-emerald-500 ring-1 ring-emerald-500/30" : "bg-amber-500/10 text-amber-500 ring-1 ring-amber-500/30") :
                      "bg-slate-900/50 text-slate-700 ring-1 ring-slate-800"
                )}>
                  {isComplete ? (
                    s.isAuthorized ? <Check className="w-10 h-10 stroke-[3]" /> : <Circle className="w-10 h-10 stroke-[4] text-amber-500" />
                  ) : (
                    isLocked ? <Lock className="w-8 h-8 opacity-30" /> : <Icon className="w-10 h-10 stroke-[1.5]" />
                  )}
                </div>

                {/* Step Title & Status */}
                <div className="flex-1 space-y-2">
                  <div className="flex items-center gap-4">
                    <h2 className="text-2xl font-bold tracking-tight">{s.title}</h2>
                    {isComplete && <StatusBadge isAuthorized={s.isAuthorized} errorMsg={s.errorMsg} />}
                    {isActive && <div className="h-1.5 w-1.5 rounded-full bg-accent-blue animate-ping" />}
                  </div>
                  <p className="text-slate-400 font-medium leading-relaxed max-w-xl">{s.description}</p>
                </div>

                {/* Logo + Buttons */}
                <div className="flex items-center gap-10 w-full lg:w-auto">
                  {s.logo && (
                    <div className={cn(
                      "hidden xl:block transition-all duration-700",
                      isActive ? "opacity-100 grayscale-0" : "opacity-20 grayscale"
                    )}>
                      <Image src={s.logo} alt={s.title} width={s.logoWidth ?? 80} height={40} className="object-contain" />
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
                      {!s.isConfig && (
                        <button
                          onClick={s.action}
                          disabled={saving || activating || s.isDisabled}
                          className={cn(
                            "px-8 py-3.5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center gap-3 transition-all duration-500 transform active:scale-95 group shadow-xl shadow-white/5 disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed",
                            s.isWebhookStep && webhookStatus === "error"
                              ? "bg-rose-500 text-white hover:bg-rose-600"
                              : "bg-white text-black hover:bg-accent-blue hover:text-white"
                          )}
                        >
                          {(saving || activating) ? <Loader2 className="w-4 h-4 animate-spin" /> : s.actionLabel}
                          {!(saving || activating) && <ChevronRight className="w-4 h-4 group-hover:translate-x-1.5 transition-transform" />}
                        </button>
                      )}
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

              {/* Expanded Content */}
              <motion.div
                animate={{ height: isActive ? "auto" : 0 }}
                className="overflow-hidden bg-slate-950/40 border-t border-slate-800/30"
              >
                {isActive && (
                  <div className="p-10 pt-8 grid md:grid-cols-2 gap-8 animate-in zoom-in-95 duration-700">
                    {s.isConfig ? (
                      <>
                        {/* IVA Incluído */}
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

                        {/* Auto Finalizar */}
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

                        {/* Razão de Isenção */}
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

                        {/* Save Button */}
                        <div className="md:col-span-2 pt-4">
                          <button
                            onClick={handleSaveSettings}
                            disabled={saving}
                            className="w-full py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl bg-white text-black hover:bg-emerald-400 hover:text-white"
                          >
                            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Zap className="w-5 h-5" /> Guardar Definições</>}
                          </button>
                        </div>
                      </>
                    ) : (
                      /* Regular field grid */
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

                    {/* Webhooks step: info note + error fallback */}
                    {s.isWebhookStep && (
                      <>
                        <div className="md:col-span-2 flex items-start gap-4 bg-violet-500/5 border border-violet-500/20 rounded-2xl px-6 py-4">
                          <Webhook className="w-5 h-5 text-violet-400 shrink-0 mt-0.5" />
                          <div>
                            <p className="text-sm font-bold text-violet-300">O que são os Webhooks?</p>
                            <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                              Os webhooks são notificações automáticas que a Shopify envia ao Rioko quando uma encomenda é paga ou um reembolso é criado. O Webhook Signing Secret valida que as notificações são autênticas. Encontra-o em <span className="text-violet-300 font-semibold">Shopify Admin → Definições → Notificações → Webhooks</span>.
                            </p>
                          </div>
                        </div>

                        {/* Manual fallback — shown when auto-install fails OR as always-available alternative */}
                        <div className="md:col-span-2 flex items-start gap-4 bg-slate-900/50 border border-slate-700/40 rounded-2xl px-6 py-4">
                          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                          <div className="flex-1">
                            <p className="text-sm font-bold text-amber-300">Token sem permissão write_webhooks?</p>
                            <p className="text-[11px] text-slate-400 mt-1 mb-3 leading-relaxed">
                              Se o teu token não tem permissão para instalar webhooks automaticamente, podes instalá-los manualmente no painel Shopify (ver instruções acima) e depois confirmar aqui.
                            </p>
                            <button
                              onClick={handleWebhooksConfirm}
                              disabled={saving || !shopifyWebhookSecret}
                              className="px-5 py-2.5 rounded-xl font-black text-[10px] uppercase tracking-widest flex items-center gap-2 bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                            >
                              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                              Confirmar Instalação Manual
                            </button>
                          </div>
                        </div>
                      </>
                    )}

                  </div>
                )}
              </motion.div>
            </motion.div>
          );
        })}

        {/* Integration Complete Card — only shows when ALL 4 steps are validated */}
        {allComplete && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.6, ease: "easeOut" }}
            className="rounded-[2.5rem] p-1 shadow-2xl bg-gradient-to-r from-emerald-500/40 via-emerald-400/10 to-emerald-500/40 shadow-[0_0_60px_rgba(16,185,129,0.25)]"
          >
            <div className="bg-slate-950 rounded-[2.3rem] p-10 flex flex-col gap-8 border border-white/5">
              {/* Header */}
              <div className="flex flex-col md:flex-row items-center justify-between gap-8">
                <div className="flex items-center gap-8">
                  <div className="w-20 h-20 rounded-[1.8rem] flex items-center justify-center bg-emerald-500/20 ring-2 ring-emerald-400 ring-offset-4 ring-offset-slate-950">
                    <ShieldCheck className="w-10 h-10 text-emerald-400" />
                  </div>
                  <div className="space-y-1">
                    <h3 className="text-2xl font-black tracking-tight">Integração Concluída</h3>
                    <p className="text-slate-500 font-bold uppercase tracking-widest text-[10px]">
                      A sua conta está configurada e protegida no Rioko 2.0
                    </p>
                  </div>
                </div>
                <div className="px-6 py-3 rounded-2xl font-black text-[10px] uppercase tracking-[0.2em] border bg-emerald-500/10 text-emerald-400 border-emerald-500/30">
                  ONLINE • REAL-TIME
                </div>
              </div>

              {/* 3-pill Diagnostic Row */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 border-t border-white/5 pt-8">
                <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-emerald-500/5 border-emerald-500/20">
                  <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-emerald-500/10">
                    <Store className="w-4 h-4 text-emerald-400" />
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">Shopify</p>
                    <p className="text-xs font-bold text-emerald-400">Autorizado</p>
                  </div>
                  <Check className="w-4 h-4 text-emerald-400 ml-auto" />
                </div>

                <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-emerald-500/5 border-emerald-500/20">
                  <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-emerald-500/10">
                    <Webhook className="w-4 h-4 text-emerald-400" />
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">Webhooks</p>
                    <p className="text-xs font-bold text-emerald-400">Registados</p>
                  </div>
                  <Check className="w-4 h-4 text-emerald-400 ml-auto" />
                </div>

                <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-emerald-500/5 border-emerald-500/20">
                  <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-emerald-500/10">
                    <CreditCard className="w-4 h-4 text-emerald-400" />
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">InvoiceXpress</p>
                    <p className="text-xs font-bold text-emerald-400">Autorizado</p>
                  </div>
                  <Check className="w-4 h-4 text-emerald-400 ml-auto" />
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </div>

      <div className="pt-12 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-900 border border-slate-800">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">D1 DATABASE LIGADA</span>
        </div>
      </div>
    </div>
  );
}
