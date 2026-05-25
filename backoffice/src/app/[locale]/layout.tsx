import type { Metadata } from "next";
export const runtime = "edge";
export const dynamic = "force-dynamic";

import { ClerkProvider } from "@clerk/nextjs";
import { ptPT, enUS } from "@clerk/localizations";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { setRequestLocale, getMessages, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import Script from "next/script";

const GA_ID = "G-CV0NZQC6HW";

import { sansDisplay, monoFont } from "../fonts";
import InactivityLogout from "@/components/InactivityLogout";
import { routing } from "@/i18n/routing";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const safeLocale = hasLocale(routing.locales, locale)
    ? locale
    : routing.defaultLocale;
  const t = await getTranslations({ locale: safeLocale, namespace: "metadata" });
  return {
    title: t("siteTitle"),
    description: t("siteDescription"),
  };
}

export default async function LocaleLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  const messages = await getMessages();
  const clerkLocalization = locale === "pt" ? ptPT : enUS;

  return (
    <ClerkProvider localization={clerkLocalization}>
      <html
        lang={locale}
        className={`${sansDisplay.variable} ${monoFont.variable}`}
      >
        <body
          className="antialiased min-h-screen overflow-x-hidden"
          style={{
            backgroundColor: "var(--background)",
            color: "var(--foreground)",
            fontFamily: "var(--font-sans-display), system-ui, sans-serif",
          }}
        >
          <NextIntlClientProvider locale={locale} messages={messages}>
            <InactivityLogout />
            <div className="brand-ambient" aria-hidden="true" />

            <div className="relative min-h-screen flex flex-col md:flex-row">
              <main className="flex-1 overflow-y-auto">{children}</main>
            </div>
          </NextIntlClientProvider>

          <Script
            src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`}
            strategy="afterInteractive"
          />
          <Script id="ga-init" strategy="afterInteractive">
            {`
              window.dataLayer = window.dataLayer || [];
              function gtag(){dataLayer.push(arguments);}
              gtag('js', new Date());
              gtag('config', '${GA_ID}');
            `}
          </Script>
        </body>
      </html>
    </ClerkProvider>
  );
}
