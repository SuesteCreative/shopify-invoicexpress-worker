"use client";

import { motion } from "framer-motion";
import {
  Zap,
  Shield,
  Layers,
  Activity,
  ArrowUpRight,
  CheckCircle2,
  Globe,
  Database,
  Cpu,
  ScrollText
} from "lucide-react";
import Link from "next/link";
import React, { useState, useEffect } from "react";

export default function RiokoPremiumDashboard() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!mounted) return null;

  return (
    <div className="min-h-screen bg-[#05080a] text-slate-200 selection:bg-emerald-500/30">
      {/* Background Orbs */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-emerald-500/10 rounded-full blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[30%] h-[30%] bg-blue-500/5 rounded-full blur-[100px]" />
      </div>

      <main className="relative z-10 max-w-7xl mx-auto px-6 py-12 lg:py-20 space-y-16">
        
        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-end justify-between gap-8">
          <motion.div 
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            className="space-y-4"
          >
            <div className="flex items-center gap-3">
              <div className="px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-[10px] font-black uppercase tracking-widest text-emerald-400">Vercel Edge Active</span>
              </div>
              <span className="text-slate-600 font-mono text-xs">v5.1.0-next</span>
            </div>
            <h1 className="text-6xl font-black tracking-tight text-gradient">
              Rioko Engine
            </h1>
            <p className="max-w-md text-slate-400 font-medium leading-relaxed">
              Automated fiscal intelligence for Shopify. Now running on the global edge network.
            </p>
          </motion.div>

          <motion.div 
             initial={{ opacity: 0, scale: 0.9 }}
             animate={{ opacity: 1, scale: 1 }}
             className="flex items-center gap-4"
          >
            <Link href="/conciliacao" className="px-6 py-3 rounded-2xl bg-emerald-500 text-[#05080a] font-black text-sm tracking-wide hover:bg-emerald-400 shadow-[0_0_20px_rgba(16,185,129,0.3)] transition-all inline-flex items-center gap-2">
              <ScrollText size={16} /> Conciliação
            </Link>
            <button className="px-6 py-3 rounded-2xl glass border-emerald-500/20 text-emerald-400 font-bold text-sm tracking-wide hover:bg-emerald-500/10 transition-all">
              Documentation
            </button>
          </motion.div>
        </header>

        {/* Core Stats Grid */}
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          {[
            { label: "Uptime", value: "99.99%", icon: Activity, color: "text-emerald-400" },
            { label: "Invoices Today", value: "142", icon: Layers, color: "text-blue-400" },
            { label: "Avg Latency", value: "24ms", icon: Zap, color: "text-amber-400" },
            { label: "Security Score", value: "A+", icon: Shield, color: "text-purple-400" }
          ].map((stat, i) => (
            <motion.div
              key={stat.label}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.1 }}
              className="glass p-8 rounded-[2rem] space-y-4 group hover:border-white/10 transition-colors"
            >
              <div className={`p-3 rounded-xl bg-white/5 w-fit ${stat.color}`}>
                <stat.icon size={20} />
              </div>
              <div className="space-y-1">
                <p className="text-3xl font-black">{stat.value}</p>
                <p className="text-xs font-bold text-slate-500 uppercase tracking-widest">{stat.label}</p>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Main Content Area */}
        <div className="grid lg:grid-cols-3 gap-8">
          
          {/* System Integrity (Wide) */}
          <motion.div 
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            className="lg:col-span-2 glass-emerald p-1 rounded-[2.5rem]"
          >
            <div className="bg-[#0a0f12] h-full w-full rounded-[2.4rem] p-10 space-y-10">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <h3 className="text-2xl font-black">System Integrity</h3>
                  <p className="text-sm text-slate-500">Real-time node synchronization status</p>
                </div>
                <div className="flex -space-x-2">
                  {[1,2,3,4].map(i => (
                    <div key={i} className="w-10 h-10 rounded-full border-4 border-[#0a0f12] bg-emerald-500/20 flex items-center justify-center text-emerald-500">
                      <Globe size={14} />
                    </div>
                  ))}
                </div>
              </div>

              {/* Futuristic Progress Visualization */}
              <div className="space-y-6">
                <div className="space-y-2">
                  <div className="flex justify-between text-[10px] font-black uppercase tracking-widest text-slate-500">
                    <span>Database Latency</span>
                    <span className="text-emerald-500">Normal</span>
                  </div>
                  <div className="h-1 w-full bg-slate-800 rounded-full overflow-hidden">
                    <motion.div 
                      initial={{ width: 0 }}
                      animate={{ width: "65%" }}
                      className="h-full bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]" />
                  </div>
                </div>
                <div className="space-y-2">
                    <div className="flex justify-between text-[10px] font-black uppercase tracking-widest text-slate-500">
                      <span>API Throughput</span>
                      <span className="text-blue-500">High Load</span>
                    </div>
                    <div className="h-1 w-full bg-slate-800 rounded-full overflow-hidden">
                      <motion.div 
                        initial={{ width: 0 }}
                        animate={{ width: "88%" }}
                        className="h-full bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.5)]" />
                    </div>
                  </div>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-3 gap-6 pt-6">
                <div className="flex items-center gap-3 p-4 rounded-2xl bg-white/5 border border-white/5">
                  <Database className="text-emerald-500" size={18} />
                  <span className="text-xs font-bold uppercase tracking-tight">Vercel KV</span>
                </div>
                <div className="flex items-center gap-3 p-4 rounded-2xl bg-white/5 border border-white/5">
                  <Cpu className="text-blue-500" size={18} />
                  <span className="text-xs font-bold uppercase tracking-tight">Edge Functions</span>
                </div>
                <div className="flex items-center gap-3 p-4 rounded-2xl bg-white/5 border border-white/5">
                  <CheckCircle2 className="text-purple-500" size={18} />
                  <span className="text-xs font-bold uppercase tracking-tight">SSL Verified</span>
                </div>
              </div>
            </div>
          </motion.div>

          {/* Activity Log (Side) */}
          <motion.div 
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className="glass p-10 rounded-[2.5rem] flex flex-col"
          >
             <h3 className="text-xl font-black mb-8 flex items-center gap-3">
               Recent Nodes <ArrowUpRight size={20} className="text-emerald-500" />
             </h3>
             <div className="space-y-6 flex-1">
                {[
                  { time: "2m ago", status: "Success", ref: "#ORD-9122", color: "bg-emerald-500" },
                  { time: "15m ago", status: "Success", ref: "#ORD-9121", color: "bg-emerald-500" },
                  { time: "1h ago", status: "Warning", ref: "#ORD-9120", color: "bg-amber-500" },
                  { time: "3h ago", status: "Success", ref: "#ORD-9119", color: "bg-emerald-500" },
                ].map((log, i) => (
                  <div key={i} className="flex items-center justify-between group cursor-pointer">
                    <div className="flex items-center gap-4">
                      <div className={`w-2 h-2 rounded-full ${log.color}`} />
                      <div className="space-y-0.5">
                        <p className="text-xs font-black text-slate-200 group-hover:text-emerald-400 transition-colors uppercase tracking-tight">{log.ref}</p>
                        <p className="text-[10px] text-slate-500 font-bold">{log.time}</p>
                      </div>
                    </div>
                    <span className="text-[9px] font-black uppercase tracking-tighter text-slate-600 px-2 py-1 rounded bg-white/5 group-hover:bg-white/10 group-hover:text-slate-200 transition-all">
                      {log.status}
                    </span>
                  </div>
                ))}
             </div>
             <button className="mt-8 w-full py-4 rounded-2xl border border-white/5 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500 hover:text-white hover:border-white/10 transition-all">
               View All Integration Logs
             </button>
          </motion.div>

        </div>

        {/* Footer */}
        <footer className="pt-12 border-t border-white/5 flex flex-col md:flex-row justify-between items-center gap-6">
           <div className="flex items-center gap-6">
             <span className="text-[10px] font-black uppercase tracking-widest text-slate-600">© 2026 Kapta / Rioko</span>
             <span className="w-1 h-1 bg-slate-800 rounded-full" />
             <span className="text-[10px] font-black uppercase tracking-widest text-slate-600 hover:text-emerald-500 cursor-pointer">Security Protocol</span>
             <span className="w-1 h-1 bg-slate-800 rounded-full" />
             <span className="text-[10px] font-black uppercase tracking-widest text-slate-600 hover:text-emerald-500 cursor-pointer">System Status</span>
           </div>
           <p className="text-[10px] font-black uppercase tracking-[0.2em] text-emerald-500/50">
             Building the future of digital billing.
           </p>
        </footer>

      </main>
    </div>
  );
}
