import type { MetadataRoute } from "next";
import { listArticles } from "@/lib/blog";

export const runtime = "edge";

const SITE = "https://rioko.online";
const LOCALES = ["pt", "en"] as const;

/** hreflang map for a path that genuinely exists in both languages. */
function bothLocales(path: string) {
    return {
        languages: {
            ...Object.fromEntries(LOCALES.map((l) => [l, `${SITE}/${l}${path}`])),
            "x-default": `${SITE}/pt${path}`,
        },
    };
}

export default function sitemap(): MetadataRoute.Sitemap {
    const entries: MetadataRoute.Sitemap = [];

    // Static pages — genuinely translated, so both locales are listed and point
    // at each other. No `lastModified`: it used to be `new Date()`, which made
    // every page look edited on every request and teaches a crawler to ignore
    // the field. Better to say nothing than to say something false.
    const staticPaths = [
        { path: "", priority: 1.0, changeFrequency: "weekly" as const },
        { path: "/shopify", priority: 0.9, changeFrequency: "weekly" as const },
        { path: "/blog", priority: 0.8, changeFrequency: "weekly" as const },
        { path: "/privacy", priority: 0.3, changeFrequency: "yearly" as const },
        { path: "/terms", priority: 0.3, changeFrequency: "yearly" as const },
    ];

    for (const { path, priority, changeFrequency } of staticPaths) {
        for (const locale of LOCALES) {
            entries.push({
                url: `${SITE}/${locale}${path}`,
                changeFrequency,
                priority,
                alternates: bothLocales(path),
            });
        }
    }

    // Articles are written in Portuguese only. `/en/blog/<slug>` renders that
    // same Portuguese body, so listing it — and labelling it hreflang="en" —
    // advertised duplicate content in a language it is not written in. Only the
    // PT URL is listed until an article is actually translated.
    for (const article of listArticles()) {
        entries.push({
            url: `${SITE}/pt/blog/${article.slug}`,
            lastModified: new Date(article.dateModified ?? article.date),
            changeFrequency: "monthly",
            priority: 0.7,
        });
    }

    return entries;
}
