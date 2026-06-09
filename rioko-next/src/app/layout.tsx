import type { Metadata } from "next";
import "./globals.css";
import { ClerkProvider } from "@clerk/nextjs";
import { ImpersonationBanner } from "@/components/ImpersonationBanner";

export const metadata: Metadata = {
  metadataBase: new URL("https://rioko.online"),
  title: {
    default: "Rioko Engine — Fiscal Intelligence for Shopify",
    template: "%s · Rioko Engine",
  },
  description:
    "Automated fiscal intelligence for Shopify. Real-time Shopify ↔ InvoiceXpress sync, NIF detection, and Portuguese fiscal compliance — running on the global edge.",
  applicationName: "Rioko Engine",
  authors: [{ name: "Kapta", url: "https://kapta.pt" }],
  creator: "Kapta",
  publisher: "Kapta",
  keywords: [
    "Shopify",
    "InvoiceXpress",
    "faturação",
    "NIF",
    "Portugal",
    "fiscal compliance",
    "automated invoicing",
    "Kapta",
    "Rioko",
  ],
  openGraph: {
    type: "website",
    url: "https://rioko.online",
    siteName: "Rioko Engine",
    title: "Rioko Engine — Fiscal Intelligence for Shopify",
    description:
      "Automated fiscal intelligence for Shopify. Real-time Shopify ↔ InvoiceXpress sync, NIF detection, and Portuguese fiscal compliance — running on the global edge.",
    locale: "pt_PT",
  },
  twitter: {
    card: "summary_large_image",
    title: "Rioko Engine — Fiscal Intelligence for Shopify",
    description:
      "Automated fiscal intelligence for Shopify. Real-time Shopify ↔ InvoiceXpress sync, NIF detection, and Portuguese fiscal compliance — running on the global edge.",
  },
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
