"use client";

export const runtime = "edge";

import { motion } from "framer-motion";
import { useState, useEffect } from "react";
import { Check, Lock, ChevronRight, Store, CreditCard, Settings2, Loader2 } from "lucide-react";
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
  const [vatIncluded, setVatIncluded] = useState(true);
  const [autoFinalize, setAutoFinalize] = useState(false);

  // Load existing data
  useEffect(() => {
    fetch("/api/integrations")
      .then(res => res.json())
      .then((data: any) => {
        if (data.shopify_domain) setShopifyDomain(data.shopify_domain);
        if (data.shopify_token) setShopifyToken(data.shopify_token);
        if (data.shopify_webhook_secret) setShopifyWebhookSecret(data.shopify_webhook_secret);
        if (data.shopify_api_version) setShopifyApiVersion(data.shopify_api_version);
        if (data.ix_account_name) setIxAccount(data.ix_account_name);
        if (data.ix_api_key) setIxApiKey(data.ix_api_key);
        if (data.vat_included !== undefined) setVatIncluded(data.vat_included === 1);
        if (data.auto_finalize !== undefined) setAutoFinalize(data.auto_finalize === 1);

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
          vat_included: vatIncluded,
          auto_finalize: autoFinalize
        })
      });

      if (response.ok) {
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
      title: "Step 1: Shopify Bridge",
      description: "Connect your store to start the integration process.",
      icon: Store,
      logo: "/images/shopify-logo.webp",
      logoWidth: 100, // Reduced from 130
      fields: [
        { label: "Shopify Domain (.myshopify.com)", value: shopifyDomain, setter: setShopifyDomain, placeholder: "quickstart-66f9e5ef.myshopify.com", type: "text" },
        { label: "Admin API Access Token", value: shopifyToken, setter: setShopifyToken, placeholder: "shpat_xxxxxxxxxxxxxxxx", type: "password" },
        { label: "Webhook Signing Secret", value: shopifyWebhookSecret, setter: setShopifyWebhookSecret, placeholder: "See Shopify Notifications > Webhooks", type: "password" },
        { label: "API Version", value: shopifyApiVersion, setter: setShopifyApiVersion, placeholder: "2026-01", type: "text" }
      ]
    },
    {
      id: 2,
      title: "Step 2: InvoiceXpress Nexus",
      description: "Enter your account details to bridge the finances.",
      icon: CreditCard,
      logo: "/images/logo-invoicexpress2.png",
      logoWidth: 120, // Adjusted for balance
      fields: [
        { label: "Account Name", value: ixAccount, setter: setIxAccount, placeholder: "ultramegasonico", type: "text" },
        { label: "API Key", value: ixApiKey, setter: setIxApiKey, placeholder: "••••••••••••••••••••••••", type: "password" }
      ]
    },
    {
      id: 3,
      title: "Step 3: Command Center",
      description: "Define the rules, taxes, and finalization levels.",
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
          <h1 className="text-5xl font-black tracking-tight bg-gradient-to-r from-white via-white to-slate-500 bg-clip-text text-transparent">Hello, Pedro</h1>
          <p className="text-slate-400 font-semibold tracking-wide flex items-center gap-2">
            Rioko 2.0 is standing by <span className="w-1 h-1 rounded-full bg-slate-600" /> Your automation is active.
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
            <span className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">Sync Status</span>
            <span className="text-xs font-bold text-emerald-400 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Real-time ACTIVE
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
                "glass rounded-[2rem] overflow-hidden relative group transition-all duration-700",
                isActive && "border-accent-blue/40 shadow-[0_20px_50px_rgba(0,0,0,0.5),0_0_30px_rgba(56,189,248,0.1)]",
                isComplete && "border-emerald-500/30 bg-emerald-500/[0.02]",
                isLocked && "grayscale scale-[0.98]"
              )}
            >
              <div className="p-10 flex flex-col lg:flex-row items-start lg:items-center gap-10">
                <div className={cn(
                  "w-20 h-20 rounded-2xl flex items-center justify-center transition-all duration-700 shrink-0 shadow-inner",
                  isActive ? "bg-accent-blue/20 text-accent-blue ring-1 ring-accent-blue/30" :
                    isComplete ? "bg-emerald-500/20 text-emerald-500 ring-1 ring-emerald-500/30" :
                      "bg-slate-900/50 text-slate-700 ring-1 ring-slate-800"
                )}>
                  {isComplete ? <Check className="w-10 h-10 stroke-[3]" /> : (isLocked ? <Lock className="w-8 h-8 opacity-30" /> : <Icon className="w-10 h-10 stroke-[1.5]" />)}
                </div>

                <div className="flex-1 space-y-2">
                  <div className="flex items-center gap-4">
                    <h2 className="text-2xl font-bold tracking-tight">{s.title}</h2>
                    {isComplete && <span className="px-3 py-1 rounded-lg bg-emerald-500/10 text-emerald-500 text-[10px] font-black uppercase tracking-[0.15em] border border-emerald-500/20">Authorized</span>}
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
                          Go Back
                        </button>
                      )}
                      <button
                        onClick={handleConnect}
                        disabled={saving || (s.id === 1 && (!shopifyDomain || !shopifyToken)) || (s.id === 2 && (!ixAccount || !ixApiKey))}
                        className="bg-white text-black px-8 py-3.5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center gap-3 hover:bg-accent-blue hover:text-white transition-all duration-500 transform active:scale-95 group shadow-xl shadow-white/5 disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed"
                      >
                        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : (s.id === 3 ? "Save Rules" : "Connect")}
                        {!saving && <ChevronRight className="w-4 h-4 group-hover:translate-x-1.5 transition-transform" />}
                      </button>
                    </div>
                  )}

                  {isComplete && (
                    <button
                      onClick={() => setStep(s.id)}
                      className="ml-auto bg-slate-800/50 hover:bg-slate-800 text-slate-300 px-5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all border border-slate-700/50"
                    >
                      Update
                    </button>
                  )}
                </div>
              </div>

              <motion.div
                animate={{ height: isActive ? 'auto' : 0 }}
                className="overflow-hidden bg-slate-950/40 border-t border-slate-800/30"
              >
                {isActive && (
                  <div className="p-10 pt-8 grid md:grid-cols-2 gap-8 animate-in zoom-in-95 duration-700">
                    {s.isConfig ? (
                      <>
                        <div className="glass p-6 rounded-2xl flex items-center justify-between border-slate-800/50">
                          <div>
                            <h3 className="font-bold text-sm">Unit with Tax</h3>
                            <p className="text-[10px] text-slate-500 font-medium mt-1 uppercase tracking-wider">Prices already include VAT</p>
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
                            <h3 className="font-bold text-sm">Auto Finalize</h3>
                            <p className="text-[10px] text-slate-500 font-medium mt-1 uppercase tracking-wider">Authorize documents immediately</p>
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
                        <div className="md:col-span-2 pt-4">
                          <button
                            onClick={handleActivate}
                            disabled={activating}
                            className={cn(
                              "w-full py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl",
                              activeStatus === "success" ? "bg-emerald-500 text-white" :
                                activeStatus === "error" ? "bg-rose-500 text-white" :
                                  "bg-white text-black hover:bg-slate-100"
                            )}
                          >
                            {activating ? <Loader2 className="w-5 h-5 animate-spin" /> :
                              activeStatus === "success" ? <Check className="w-5 h-5" /> :
                                activeStatus === "error" ? "Retry Activation" : "Activate & Sync Webhooks"}
                            {activeStatus === "success" ? "Webhooks Active" : activeStatus === "error" ? "" : ""}
                          </button>
                          {activeStatus === "success" && (
                            <p className="text-[10px] text-emerald-500 font-bold uppercase tracking-wider text-center mt-3 animate-in fade-in slide-in-from-top-2">
                              Successfully registered webhooks for {shopifyDomain}
                            </p>
                          )}
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
                )}
              </motion.div>
            </motion.div>
          );
        })}
      </div>

      <div className="pt-12 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-900 border border-slate-800">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">D1 DATABASE CONNECTED</span>
        </div>
      </div>
    </div>
  );
}
