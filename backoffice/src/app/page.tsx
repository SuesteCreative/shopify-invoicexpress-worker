import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { ArrowRight, Bot, ShieldCheck, Zap } from "lucide-react";

export const runtime = "edge";

export default async function LandingPage() {
  const { userId } = await auth();

  if (userId) {
    redirect("/dashboard");
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white flex flex-col font-sans selection:bg-sky-500/30">
      {/* Background gradients */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-sky-500/10 rounded-full blur-[120px] animate-pulse" />
        <div className="absolute bottom-[10%] right-[-10%] w-[30%] h-[30%] bg-purple-500/10 rounded-full blur-[100px]" />
      </div>

      {/* Nav */}
      <nav className="relative z-10 max-w-7xl mx-auto w-full px-6 py-8 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 relative flex items-center justify-center">
            <div className="absolute inset-0 bg-sky-400 blur-sm opacity-20" />
            <Image src="/logo-rioko-white.svg" alt="Rioko 2.0" width={48} height={48} className="relative drop-shadow-2xl" />
          </div>
          <div>
            <span className="text-2xl font-black tracking-tighter text-white">RIOKO</span>
            <span className="ml-1 text-[10px] font-black bg-sky-500 text-white px-1.5 py-0.5 rounded-md uppercase tracking-wider">2.0</span>
          </div>
        </div>

        <Link href="/sign-in" className="group flex items-center gap-2 px-6 py-2.5 rounded-full bg-slate-900 border border-slate-800 text-sm font-bold text-white hover:bg-slate-800 transition-all">
          Entre na sua conta
          <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
        </Link>
      </nav>

      {/* Hero */}
      <main className="relative z-10 flex-1 max-w-7xl mx-auto w-full px-6 flex flex-col items-center justify-center text-center">
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-sky-500/10 border border-sky-500/20 text-sky-400 text-xs font-black tracking-widest uppercase mb-8">
          <Zap className="w-3 h-3" /> Automate your commerce
        </div>

        <h1 className="text-5xl md:text-8xl font-black tracking-tight mb-8 max-w-4xl text-transparent bg-clip-text bg-gradient-to-br from-white via-white to-slate-500 leading-[1.1]">
          Faturação sem <span className="text-sky-400">esforço</span>, lucros em automático.
        </h1>

        <p className="text-slate-400 text-lg md:text-xl font-medium max-w-2xl mb-12">
          A ponte definitiva entre a sua loja Shopify e o InvoiceXpress.
          Configure uma vez, fature para sempre.
        </p>

        <div className="flex flex-col sm:flex-row items-center gap-4">
          <Link href="/sign-up" className="px-10 py-4 rounded-2xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-black text-lg transition-all shadow-[0_0_40px_-5px_rgba(14,165,233,0.3)] hover:scale-105 active:scale-95">
            Começar Grátis agora
          </Link>
          <div className="flex items-center gap-2 px-6 py-4 text-slate-500 text-sm font-bold group">
            <ShieldCheck className="w-5 h-5 text-sky-500" /> Segurança Kapta Garantida
          </div>
        </div>

        <div className="mt-24 grid grid-cols-1 md:grid-cols-3 gap-8 w-full max-w-5xl">
          {[
            { icon: Zap, title: "Faturação em Milissegundos", desc: "Assim que a encomenda é paga, o documento é gerado no IX." },
            { icon: ShieldCheck, title: "Zero Duplicados", desc: "Filtros de idempotência que garantem faturação única e correta." },
            { icon: Bot, title: "Automação Pura", desc: "Gestão automática de reembolsos e notas de crédito." }
          ].map((feature, i) => (
            <div key={i} className="p-8 rounded-3xl bg-slate-900/50 border border-slate-800/50 text-left hover:border-sky-500/30 transition-all group">
              <feature.icon className="w-8 h-8 text-sky-500 mb-4 group-hover:scale-110 transition-transform" />
              <h3 className="text-white font-black text-xl mb-2">{feature.title}</h3>
              <p className="text-slate-500 font-medium text-sm leading-relaxed">{feature.desc}</p>
            </div>
          ))}
        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 py-12 text-center">
        <div className="text-slate-600 text-xs font-bold uppercase tracking-widest">
          Uma criação estratégica da <a href="https://kapta.pt" className="text-white hover:text-sky-400 transition-colors">KAPTA.PT</a>
        </div>
      </footer>
    </div>
  );
}
