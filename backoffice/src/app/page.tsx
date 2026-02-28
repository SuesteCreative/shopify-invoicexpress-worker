"use client";

import { motion } from "framer-motion";
import { useState } from "react";
import { Check, Lock, ChevronRight, Store, CreditCard, Settings2 } from "lucide-react";
import Image from "next/image";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function Dashboard() {
  const [step, setStep] = useState(1);
  const [shopifyDomain, setShopifyDomain] = useState("");
  const [shopifyToken, setShopifyToken] = useState("");
  const [ixAccount, setIxAccount] = useState("");
  const [ixApiKey, setIxApiKey] = useState("");

  const steps = [
    {
      id: 1,
      title: "Step 1: Shopify Bridge",
      description: "Connect your store to start the integration process.",
      icon: Store,
      logo: "/images/shopify-logo.webp", // Use local logo
      color: "emerald"
    },
    {
      id: 2,
      title: "Step 2: InvoiceXpress Nexus",
      description: "Enter your account details to bridge the finances.",
      icon: CreditCard,
      logo: "/images/invoicexpress_logo.png",
      color: "blue"
    },
    {
      id: 3,
      title: "Step 3: Command Center",
      description: "Define the rules, taxes, and finalization levels.",
      icon: Settings2,
      color: "purple"
    }
  ];

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

      {/* The Set-up Bars (The Triple Path) */}
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

                {/* Step Indicator */}
                <div className={cn(
                  "w-20 h-20 rounded-2xl flex items-center justify-center transition-all duration-700 shrink-0 shadow-inner",
                  isActive ? "bg-accent-blue/20 text-accent-blue ring-1 ring-accent-blue/30" :
                    isComplete ? "bg-emerald-500/20 text-emerald-500 ring-1 ring-emerald-500/30" :
                      "bg-slate-900/50 text-slate-700 ring-1 ring-slate-800"
                )}>
                  {isComplete ? <Check className="w-10 h-10 stroke-[3]" /> : (isLocked ? <Lock className="w-8 h-8 opacity-30" /> : <Icon className="w-10 h-10 stroke-[1.5]" />)}
                </div>

                {/* Text Content */}
                <div className="flex-1 space-y-2">
                  <div className="flex items-center gap-4">
                    <h2 className="text-2xl font-bold tracking-tight">{s.title}</h2>
                    {isComplete && <span className="px-3 py-1 rounded-lg bg-emerald-500/10 text-emerald-500 text-[10px] font-black uppercase tracking-[0.15em] border border-emerald-500/20">Authorized</span>}
                    {isActive && <div className="h-1.5 w-1.5 rounded-full bg-accent-blue animate-ping" />}
                  </div>
                  <p className="text-slate-400 font-medium leading-relaxed max-w-xl">{s.description}</p>
                </div>

                {/* Actions / Logos Area */}
                <div className="flex items-center gap-10 w-full lg:w-auto">
                  {s.logo && (
                    <div className={cn(
                      "hidden xl:block transition-all duration-700",
                      isActive ? "opacity-100 grayscale-0" : "opacity-20 grayscale"
                    )}>
                      <Image
                        src={s.logo}
                        alt={`${s.title} Logo`}
                        width={s.id === 1 ? 130 : 160}
                        height={45}
                        className="object-contain"
                      />
                    </div>
                  )}

                  {isActive && (
                    <button
                      onClick={() => setStep(step + 1)}
                      className="ml-auto bg-white text-black px-8 py-3.5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center gap-3 hover:bg-accent-blue hover:text-white transition-all duration-500 transform active:scale-95 group shadow-xl shadow-white/5"
                    >
                      Connect
                      <ChevronRight className="w-4 h-4 group-hover:translate-x-1.5 transition-transform" />
                    </button>
                  )}
                </div>
              </div>

              {/* Expanded Content Area with REAL labels */}
              <motion.div
                animate={{ height: isActive ? 'auto' : 0 }}
                className="overflow-hidden bg-slate-950/40 border-t border-slate-800/30"
              >
                {isActive && (
                  <div className="p-10 pt-8 grid md:grid-cols-2 gap-8 animate-in zoom-in-95 duration-700">
                    <div className="space-y-3">
                      <label className="text-[10px] text-slate-500 font-black uppercase tracking-[0.2em] ml-1 flex items-center gap-2">
                        <span className="w-1 h-1 rounded-full bg-accent-blue" />
                        {s.id === 1 ? "Shopify Domain (.myshopify.com)" : "Account Name"}
                      </label>
                      <input
                        type="text"
                        placeholder={s.id === 1 ? "your-store.myshopify.com" : "account-name"}
                        className="w-full bg-slate-950/50 border border-slate-800/80 rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent-blue/20 focus:border-accent-blue outline-none transition-all placeholder:text-slate-800"
                      />
                    </div>
                    <div className="space-y-3">
                      <label className="text-[10px] text-slate-500 font-black uppercase tracking-[0.2em] ml-1 flex items-center gap-2">
                        <span className="w-1 h-1 rounded-full bg-accent-blue" />
                        {s.id === 1 ? "Admin API Access Token" : "API Key"}
                      </label>
                      <input
                        type="password"
                        placeholder="••••••••••••••••••••••••"
                        className="w-full bg-slate-950/50 border border-slate-800/80 rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent-blue/20 focus:border-accent-blue outline-none transition-all placeholder:text-slate-800"
                      />
                    </div>
                  </div>
                )}
              </motion.div>
            </motion.div>
          );
        })}
      </div>

      {/* Footer System Status */}
      <div className="pt-12 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-900 border border-slate-800">
          <div className="w-2 h-2 rounded-full bg-amber-500" />
          <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Database Setup Pending</span>
        </div>
      </div>

    </div>
  );
}
