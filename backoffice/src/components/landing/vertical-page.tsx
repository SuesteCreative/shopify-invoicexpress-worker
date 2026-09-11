import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import VerticalLanding from "./VerticalLanding";
import type { VerticalVariant } from "./vertical-config";
import JsonLd from "@/components/JsonLd";
import {
    breadcrumbSchema,
    faqSchema,
    howToSchema,
    softwareApplicationSchema,
} from "@/lib/schema";
import { ledgerDisplay, ledgerMono } from "@/app/vertical-fonts";

const SITE = "https://rioko.online";

/**
 * The shared body of a vertical landing route. Each route file is then just a
 * variant plus the two Next exports, instead of 120 lines copied per platform.
 */
export async function verticalMetadata(
    variant: VerticalVariant,
    locale: string
): Promise<Metadata> {
    const t = await getTranslations({ locale, namespace: `${variant.ns}.meta` });
    const title = t("title");
    const description = t("description");
    const path = `/${variant.slug}`;

    return {
        title,
        description,
        alternates: {
            canonical: `/${locale}${path}`,
            languages: {
                pt: `/pt${path}`,
                en: `/en${path}`,
                "x-default": `/pt${path}`,
            },
        },
        openGraph: {
            type: "website",
            siteName: "Rioko",
            url: `${SITE}/${locale}${path}`,
            locale: locale === "pt" ? "pt_PT" : "en_US",
            title,
            description,
        },
        twitter: { card: "summary_large_image", title, description },
    };
}

export async function VerticalPage({
    variant,
    locale,
}: {
    variant: VerticalVariant;
    locale: string;
}) {
    setRequestLocale(locale);

    // FAQ + HowTo copy shared with the on-page sections — emitted server-side as
    // JSON-LD so crawlers and AI answer engines read every answer without JS.
    const tFaq = await getTranslations({ locale, namespace: `${variant.ns}.faq` });
    const faqItems = tFaq.raw("items") as Array<{ q: string; a: string }>;

    const tHow = await getTranslations({ locale, namespace: `${variant.ns}.how` });
    const howSteps = [1, 2, 3].map((n) => ({
        name: tHow(`step${n}.title`),
        text: tHow(`step${n}.body`),
    }));

    const tCrumb = await getTranslations({
        locale,
        namespace: `${variant.ns}.breadcrumb`,
    });

    const howToName =
        locale === "en"
            ? `How to set up automatic ${variant.origin.name} invoicing with Rioko`
            : `Como configurar faturação automática com ${variant.origin.name} e o Rioko`;

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
                    anchor: `/${variant.slug}#como-funciona`,
                })}
            />
            <JsonLd
                data={breadcrumbSchema([
                    { name: tCrumb("home"), url: `${SITE}/${locale}` },
                    {
                        name: tCrumb("page"),
                        url: `${SITE}/${locale}/${variant.slug}`,
                    },
                ])}
            />
            <VerticalLanding variant={variant} />
        </div>
    );
}
