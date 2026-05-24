import type { Metadata } from "next";
export const runtime = 'edge';
export const dynamic = 'force-dynamic';
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import { sansDisplay, monoFont } from "./fonts";
import InactivityLogout from "@/components/InactivityLogout";

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
      <html lang="pt" className={`${sansDisplay.variable} ${monoFont.variable}`}>
        <body
          className="antialiased min-h-screen overflow-x-hidden"
          style={{
            backgroundColor: "var(--background)",
            color: "var(--foreground)",
            fontFamily: "var(--font-sans-display), system-ui, sans-serif",
          }}
        >
          <InactivityLogout />
          <div className="brand-ambient" aria-hidden="true" />

          <div className="relative min-h-screen flex flex-col md:flex-row">
            <main className="flex-1 overflow-y-auto">
              {children}
            </main>
          </div>
        </body>
      </html>
    </ClerkProvider>
  );
}
