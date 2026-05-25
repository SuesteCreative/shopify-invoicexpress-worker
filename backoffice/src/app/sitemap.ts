import type { MetadataRoute } from "next";
import { listArticles } from "@/lib/blog";

export const runtime = "edge";

const SITE = "https://rioko.online";
const LOCALES = ["pt", "en"] as const;

export default function sitemap(): MetadataRoute.Sitemap {
    const now = new Date();
    const entries: MetadataRoute.Sitemap = [];

    // Static pages — duplicate per locale with hreflang
    const staticPaths = [
        { path: "", priority: 1.0, changeFrequency: "weekly" as const },
        { path: "/privacy", priority: 0.3, changeFrequency: "yearly" as const },
        { path: "/terms", priority: 0.3, changeFrequency: "yearly" as const },
        { path: "/blog", priority: 0.8, changeFrequency: "weekly" as const },
    ];

    for (const { path, priority, changeFrequency } of staticPaths) {
        for (const locale of LOCALES) {
            entries.push({
                url: `${SITE}/${locale}${path}`,
                lastModified: now,
                changeFrequency,
                priority,
                alternates: {
                    languages: Object.fromEntries(
                        LOCALES.map((l) => [l, `${SITE}/${l}${path}`])
                    ),
                },
            });
        }
    }

    // Blog articles — locale-aware
    for (const article of listArticles()) {
        for (const locale of LOCALES) {
            entries.push({
                url: `${SITE}/${locale}/blog/${article.slug}`,
                lastModified: new Date(article.date),
                changeFrequency: "monthly",
                priority: 0.7,
                alternates: {
                    languages: Object.fromEntries(
                        LOCALES.map((l) => [l, `${SITE}/${l}/blog/${article.slug}`])
                    ),
                },
            });
        }
    }

    return entries;
}
