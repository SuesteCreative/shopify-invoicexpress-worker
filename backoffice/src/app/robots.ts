import type { MetadataRoute } from "next";

export const runtime = "edge";

// Private app surfaces — kept out of every crawler, human or AI.
const DISALLOW = [
    "/api/",
    "/sign-in",
    "/sign-up",
    "/dashboard",
    "/integrations",
    "/conciliacao",
    "/faturacao",
    "/help",
    "/superadmin",
    "/client-rules",
    "/invoices",
];

// AI answer engines explicitly invited for grounding / citation (GEO).
const AI_BOTS = [
    "GPTBot",
    "OAI-SearchBot",
    "ChatGPT-User",
    "ClaudeBot",
    "anthropic-ai",
    "PerplexityBot",
    "Perplexity-User",
    "Google-Extended",
    "Applebot-Extended",
];

export default function robots(): MetadataRoute.Robots {
    return {
        rules: [
            { userAgent: AI_BOTS, allow: "/", disallow: DISALLOW },
            { userAgent: "*", allow: "/", disallow: DISALLOW },
        ],
        sitemap: "https://rioko.online/sitemap.xml",
        host: "https://rioko.online",
    };
}
