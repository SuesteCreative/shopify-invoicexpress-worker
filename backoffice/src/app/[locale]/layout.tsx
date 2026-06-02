import type { Metadata } from "next";
export const runtime = "edge";
export const dynamic = "force-dynamic";

import { ClerkProvider } from "@clerk/nextjs";
import { ptPT, enUS } from "@clerk/localizations";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { setRequestLocale, getMessages, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import Script from "next/script";

const GA_ID = "G-VJBW01N7DM";

import { sansDisplay, monoFont } from "../fonts";
import InactivityLogout from "@/components/InactivityLogout";
import ConsentBanner from "@/components/ConsentBanner";
import AttributionCapture from "@/components/AttributionCapture";
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
  const title = t("siteTitle");
  const description = t("siteDescription");
  const ogLocale = safeLocale === "pt" ? "pt_PT" : "en_US";
  return {
    metadataBase: new URL("https://rioko.online"),
    title,
    description,
    // og:image + twitter:image (+ dimensions) are injected automatically
    // from app/opengraph-image.png — only the textual fields live here.
    openGraph: {
      type: "website",
      siteName: "Rioko",
      url: "https://rioko.online",
      locale: ogLocale,
      title,
      description,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
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
            <AttributionCapture />
            <ConsentBanner />
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
              gtag('consent', 'default', {
                ad_storage: 'denied',
                ad_user_data: 'denied',
                ad_personalization: 'denied',
                analytics_storage: 'denied',
                wait_for_update: 500
              });
              gtag('js', new Date());
              gtag('config', '${GA_ID}');
            `}
          </Script>
        </body>
      </html>
    </ClerkProvider>
  );
}
