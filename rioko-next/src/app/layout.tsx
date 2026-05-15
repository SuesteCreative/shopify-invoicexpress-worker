import type { Metadata } from "next";
import "./globals.css";
import { ClerkProvider } from "@clerk/nextjs";
import { ImpersonationBanner } from "@/components/ImpersonationBanner";

export const metadata: Metadata = {
  title: "Rioko Engine | Vercel Edition",
  description: "Premium automated fiscal intelligence for Shopify",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html lang="pt">
        <body className="bg-slate-950 text-white min-h-screen antialiased">
          <ImpersonationBanner />
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
