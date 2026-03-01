import type { Metadata } from "next";
import { Outfit } from "next/font/google";
import { ClerkProvider, UserButton, SignOutButton } from "@clerk/nextjs";
import "./globals.css";
import Image from "next/image";
import Link from "next/link";
import { LogOut } from "lucide-react";
import InactivityLogout from "@/components/InactivityLogout";

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
      <html lang="pt">
        <body className={`${outfit.className} antialiased bg-slate-950 text-white min-h-screen overflow-x-hidden`}>
          <InactivityLogout />
          {/* Dashboard Mesh Background */}
          <div className="glow-mesh" aria-hidden="true" />

          {/* Root Content Shell */}
          <div className="relative min-h-screen flex flex-col md:flex-row">
            {/* Main Content Area */}
            <main className="flex-1 overflow-y-auto">
              {children}
            </main>
          </div>
        </body>
      </html>
    </ClerkProvider>
  );
}
