import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { setRequestLocale, getTranslations } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import Landing from "@/components/landing/Landing";
import JsonLd from "@/components/JsonLd";
import { faqSchema, howToSchema, softwareApplicationSchema } from "@/lib/schema";
import { sansDisplay, monoFont } from "../fonts";

export const runtime = "edge";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  return {
    alternates: {
      canonical: `/${locale}`,
      languages: { pt: "/pt", en: "/en", "x-default": "/pt" },
    },
  };
}

export default async function LandingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const { userId } = await auth();

  if (userId) {
    redirect({ href: "/dashboard", locale });
  }

  // FAQ items shared with the on-page accordion (landing.faq.items) — emitted
  // server-side as FAQPage JSON-LD so crawlers / AI engines get every answer.
  const tFaq = await getTranslations({ locale, namespace: "landing.faq" });
  const faqItems = tFaq.raw("items") as Array<{ q: string; a: string }>;

  // "How it works" 3-step flow (landing.how) — emitted as HowTo JSON-LD so the
  // setup steps are rich-result eligible and directly answer "how to set up".
  const tHow = await getTranslations({ locale, namespace: "landing.how" });
  const howSteps = [1, 2, 3].map((n) => ({
    name: tHow(`step${n}.title`),
    text: tHow(`step${n}.body`),
  }));

  return (
    <div
      className={`${sansDisplay.variable} ${monoFont.variable}`}
      style={{ fontFamily: "var(--font-sans-display), system-ui, sans-serif" }}
    >
      <JsonLd data={softwareApplicationSchema(locale)} />
      <JsonLd data={faqSchema(faqItems)} />
      <JsonLd data={howToSchema(howSteps, { locale })} />
      <Landing />
    </div>
  );
}
