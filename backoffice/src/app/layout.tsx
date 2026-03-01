import type { Metadata } from "next";
import { Outfit } from "next/font/google";
import { ClerkProvider, UserButton, SignOutButton } from "@clerk/nextjs";
import "./globals.css";
import Image from "next/image";
import { LogOut, User } from "lucide-react";

const outfit = Outfit({
  subsets: ["latin"],
  weight: ["300", "400", "600", "700"],
  variable: "--font-outfit",
});

export const metadata: Metadata = {
  title: "Rioko 2.0 | Developed by Kapta",
  description: "Next-generation Shopify to InvoiceXpress integration platform.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body className={`${outfit.variable} font-sans antialiased text-white bg-slate-950`}>
          {/* Dashboard Mesh Background */}
          <div className="glow-mesh" aria-hidden="true" />

          {/* Root Content Shell */}
          <div className="relative min-h-screen flex flex-col md:flex-row">

            {/* Sidebar (Kapta Branded) */}
            <aside className="w-full md:w-72 glass border-r-0 md:border-r border-slate-800/60 p-8 flex flex-col items-center md:items-start shrink-0">
              <div className="mb-14 flex flex-col items-center md:items-start">
                <div className="flex items-start gap-4">
                  <Image
                    src="/images/logo-rioko-white.svg"
                    alt="Rioko Logo"
                    width={130}
                    height={32}
                    className="brightness-125 pt-1.5"
                    priority
                  />
                  <span className="text-accent-blue bg-accent-blue/10 px-2 py-0.5 rounded-md text-[11px] font-black tracking-tight border border-accent-blue/20">2.0</span>
                </div>
                <div className="mt-4 text-[10px] text-slate-500 uppercase tracking-[0.25em] font-bold flex items-center gap-2">
                  <span className="opacity-50">dev by</span>
                  <a href="https://kapta.pt/" target="_blank" rel="noopener noreferrer" className="inline-block transition-transform hover:scale-105">
                    <Image
                      src="/images/logo-kapta-white.webp"
                      alt="Kapta Logo"
                      width={50}
                      height={14}
                      className="opacity-40 grayscale hover:opacity-100 hover:grayscale-0 transition-all duration-500"
                    />
                  </a>
                </div>
              </div>

              <nav className="flex-1 w-full space-y-3">
                <div className="px-4 py-2 flex items-center justify-between">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em] opacity-60">Main Account</span>
                  <span className="px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-500 text-[8px] font-black uppercase tracking-widest border border-rose-500/20">Beta</span>
                </div>
                <button className="w-full text-left px-4 py-3 rounded-xl bg-accent-blue/5 text-accent-blue font-semibold flex items-center gap-3 border border-accent-blue/20 shadow-[0_0_15px_rgba(56,189,248,0.05)]">
                  <div className="w-2 h-2 rounded-full bg-accent-blue shadow-[0_0_8px_rgba(56,189,248,0.5)] animate-pulse" />
                  Integrations
                </button>
              </nav>

              <div className="mt-auto space-y-4 w-full">
                <div className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-slate-800/50 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <UserButton afterSignOutUrl="/" />
                    <div className="flex flex-col">
                      <span className="text-[10px] font-black text-white uppercase tracking-wider">Account</span>
                      <span className="text-[9px] text-slate-500 font-bold uppercase truncate max-w-[100px]">Connected</span>
                    </div>
                  </div>
                  <SignOutButton>
                    <button className="p-2 rounded-lg hover:bg-rose-500/10 text-slate-500 hover:text-rose-500 transition-all cursor-pointer">
                      <LogOut className="w-4 h-4" />
                    </button>
                  </SignOutButton>
                </div>

                <div className="pt-6 border-t border-slate-800/50 w-full text-center md:text-left space-y-1">
                  <div className="text-[10px] text-slate-500 font-bold whitespace-nowrap">© 2026 Kapta. Todos os direitos reservados.</div>
                  <div className="text-[9px] text-slate-700 font-black tracking-widest uppercase">v2.0.0 Stable Build</div>
                </div>
              </div>
            </aside>

            {/* Main Application Area */}
            <main className="flex-1 p-6 md:p-12 overflow-y-auto">
              <div className="max-w-5xl mx-auto">
                {children}
              </div>
            </main>
          </div>
        </body>
      </html>
    </ClerkProvider>
  );
}
