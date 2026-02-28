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
      logo: "/images/shopify_logo.png", // Use local logo
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
    <div className="space-y-12 animate-in fade-in duration-700">

      {/* Welcome Message */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h1 className="text-4xl font-extrabold tracking-tight mb-2">Welcome Back, Pedro</h1>
          <p className="text-slate-400 font-medium">Rioko 2.0 is standing by. Your automation is active.</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex -space-x-3 overflow-hidden">
            <div className="inline-block h-8 w-8 rounded-full ring-2 ring-slate-900 bg-emerald-500/20 flex items-center justify-center border border-emerald-500/50">
              <Store className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="inline-block h-8 w-8 rounded-full ring-2 ring-slate-900 bg-blue-500/20 flex items-center justify-center border border-blue-500/50">
              <CreditCard className="w-4 h-4 text-blue-400" />
            </div>
          </div>
          <span className="text-xs font-bold text-slate-500 uppercase tracking-widest pl-2">Syncing in real-time</span>
        </div>
      </div>

      {/* The Set-up Bars (The Triple Path) */}
      <div className="grid gap-6">
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
                scale: isActive ? 1.02 : 1,
                opacity: isLocked ? 0.4 : 1,
              }}
              className={cn(
                "glass rounded-2xl overflow-hidden relative group transition-all duration-500",
                isActive && "ring-2 ring-accent-blue/30 shadow-2xl shadow-accent-blue/10",
                isComplete && "border-emerald-500/30",
                isLocked && "grayscale blur-[1px]"
              )}
            >
              {/* Background Glow for active state */}
              {isActive && (
                <div className="absolute top-0 right-0 w-64 h-full bg-accent-blue/5 blur-[80px] -z-1" />
              )}

              <div className="p-8 flex flex-col md:flex-row items-start md:items-center gap-8">

                {/* Step Indicator */}
                <div className={cn(
                  "w-16 h-16 rounded-xl flex items-center justify-center transition-all duration-500 shrink-0",
                  isActive ? "bg-accent-blue/20 text-accent-blue rotate-6" :
                    isComplete ? "bg-emerald-500/20 text-emerald-500" :
                      "bg-slate-800 text-slate-500"
                )}>
                  {isComplete ? <Check className="w-8 h-8" /> : (isLocked ? <Lock className="w-8 h-8 opacity-50" /> : <Icon className="w-8 h-8" />)}
                </div>

                {/* Text Content */}
                <div className="flex-1 space-y-1">
                  <div className="flex items-center gap-3">
                    <h2 className="text-xl font-bold tracking-tight">{s.title}</h2>
                    {isComplete && <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 text-[10px] font-bold uppercase tracking-wider">Connected</span>}
                  </div>
                  <p className="text-slate-400 text-sm leading-relaxed">{s.description}</p>
                </div>

                {/* Actions / Logos Area */}
                <div className="flex items-center gap-6 w-full md:w-auto">
                  {s.logo && (
                    <div className="hidden lg:block opacity-40 hover:opacity-100 transition-opacity grayscale hover:grayscale-0">
                      <Image
                        src={s.logo}
                        alt={`${s.title} Logo`}
                        width={s.id === 1 ? 100 : 130}
                        height={35}
                        className="object-contain"
                      />
                    </div>
                  )}

                  {isActive && (
                    <button
                      onClick={() => setStep(step + 1)}
                      className="ml-auto bg-white text-black px-6 py-2.5 rounded-full font-bold text-sm flex items-center gap-2 hover:bg-accent-blue hover:text-white transition-all duration-300 transform active:scale-95 group"
                    >
                      Connect Now
                      <ChevronRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                    </button>
                  )}
                </div>
              </div>

              {/* Collapsed / Expanded Content Area (Placeholders for now) */}
              <motion.div
                animate={{ height: isActive ? 'auto' : 0 }}
                className="overflow-hidden bg-slate-900/40"
              >
                {isActive && (
                  <div className="p-8 pt-0 grid md:grid-cols-2 gap-4 animate-in slide-in-from-top-4 duration-500">
                    <div className="space-y-2">
                      <label className="text-xs text-slate-500 font-bold uppercase tracking-wider ml-1">Setup Label</label>
                      <input
                        type="text"
                        placeholder="Paste your configuration here..."
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm focus:ring-1 focus:ring-accent-blue outline-none transition-all placeholder:text-slate-700"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-slate-500 font-bold uppercase tracking-wider ml-1">Safety Key</label>
                      <input
                        type="password"
                        placeholder="••••••••••••••••"
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm focus:ring-1 focus:ring-accent-blue outline-none transition-all placeholder:text-slate-700"
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
