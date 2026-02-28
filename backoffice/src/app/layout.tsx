import type { Metadata } from "next";
import { Outfit } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import Image from "next/image";

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
            <aside className="w-full md:w-64 glass border-r-0 md:border-r border-slate-800 p-6 flex flex-col items-center md:items-start">
              <div className="mb-12 flex flex-col items-center md:items-start">
                <div className="flex items-center gap-3">
                  <Image
                    src="/images/logo-rioko-white.svg"
                    alt="Rioko Logo"
                    width={120}
                    height={30}
                    className="brightness-110"
                  />
                  <span className="text-accent-blue bg-accent-blue/10 px-1.5 py-0.5 rounded text-[10px] font-bold tracking-tight">2.0</span>
                </div>
                <div className="mt-2 text-[10px] text-slate-500 uppercase tracking-[0.2em] font-semibold flex items-center gap-1.5">
                  <span className="opacity-70">powered by</span>
                  <Image
                    src="/images/logo-kapta-white.webp"
                    alt="Kapta Logo"
                    width={50}
                    height={15}
                    className="opacity-90 grayscale brightness-125 hover:grayscale-0 transition-all duration-300"
                  />
                </div>
              </div>

              <nav className="flex-1 w-full space-y-2">
                <div className="px-3 py-2 text-xs font-semibold text-slate-500 uppercase tracking-widest">
                  Main Account
                </div>
                <button className="w-full text-left px-3 py-2.5 rounded-lg bg-accent-blue/10 text-accent-blue font-medium flex items-center gap-3 glass">
                  <div className="w-2 h-2 rounded-full bg-accent-blue animate-pulse" />
                  Integrations
                </button>
              </nav>

              <div className="mt-auto pt-6 border-t border-slate-800/50 w-full text-center md:text-left">
                <div className="text-[10px] text-slate-500 font-medium">© 2026 Rioko & Kapta.</div>
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
