import type { Metadata } from "next";
import { setRequestLocale, getTranslations } from "next-intl/server";
import ShopifyLanding from "@/components/landing/ShopifyLanding";
import JsonLd from "@/components/JsonLd";
import {
  breadcrumbSchema,
  faqSchema,
  howToSchema,
  softwareApplicationSchema,
} from "@/lib/schema";
import { ledgerDisplay, ledgerMono } from "./fonts";

export const runtime = "edge";

const SITE = "https://rioko.online";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "shopifyLanding.meta" });
  const title = t("title");
  const description = t("description");

  return {
    title,
    description,
    alternates: {
      canonical: `/${locale}/shopify`,
      languages: {
        pt: "/pt/shopify",
        en: "/en/shopify",
        "x-default": "/pt/shopify",
      },
    },
    openGraph: {
      type: "website",
      siteName: "Rioko",
      url: `${SITE}/${locale}/shopify`,
      locale: locale === "pt" ? "pt_PT" : "en_US",
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

export default async function ShopifyLandingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  // FAQ + HowTo copy shared with the on-page sections — emitted server-side
  // as JSON-LD so crawlers and AI answer engines read every answer without JS.
  const tFaq = await getTranslations({
    locale,
    namespace: "shopifyLanding.faq",
  });
  const faqItems = tFaq.raw("items") as Array<{ q: string; a: string }>;

  const tHow = await getTranslations({
    locale,
    namespace: "shopifyLanding.how",
  });
  const howSteps = [1, 2, 3].map((n) => ({
    name: tHow(`step${n}.title`),
    text: tHow(`step${n}.body`),
  }));

  const tCrumb = await getTranslations({
    locale,
    namespace: "shopifyLanding.breadcrumb",
  });

  const howToName =
    locale === "en"
      ? "How to set up automatic Shopify invoicing with Rioko"
      : "Como configurar faturação automática na Shopify com o Rioko";

  return (
    <div
      className={`${ledgerDisplay.variable} ${ledgerMono.variable}`}
      style={{ fontFamily: "var(--font-sans-display), system-ui, sans-serif" }}
    >
      <JsonLd data={softwareApplicationSchema(locale)} />
      <JsonLd data={faqSchema(faqItems)} />
      <JsonLd
        data={howToSchema(howSteps, {
          locale,
          name: howToName,
          anchor: "/shopify#como-funciona",
        })}
      />
      <JsonLd
        data={breadcrumbSchema([
          { name: tCrumb("home"), url: `${SITE}/${locale}` },
          { name: tCrumb("page"), url: `${SITE}/${locale}/shopify` },
        ])}
      />
      <ShopifyLanding />
    </div>
  );
}
