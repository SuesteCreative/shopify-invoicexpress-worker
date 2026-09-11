import type { MetadataRoute } from "next";

export const runtime = "edge";

// Private app surfaces — kept out of every crawler, human or AI.
// Every real URL is locale-prefixed (`/pt/dashboard`), so each path needs the
// `/*/` wildcard form too: a bare `Disallow: /dashboard` matches nothing and
// silently protects nothing.
const APP_PATHS = [
    "/dashboard",
    "/integrations",
    "/conciliacao",
    "/faturacao",
    "/help",
    "/superadmin",
    "/client-rules",
    "/invoices",
    "/users",
    "/ops",
    "/onboarding-helper",
    "/onboarding",
    "/sign-in",
    "/sign-up",
];

// `/admin` goes in directly, never through APP_PATHS: that list is expanded
// into `/x` and `/*/x` because those routes are locale-prefixed, and the admin
// surface deliberately is not — `/pt/admin` does not exist.
const DISALLOW = ["/api/", "/admin", ...APP_PATHS.flatMap((p) => [p, `/*${p}`])];

/**
 * AI crawlers explicitly invited.
 *
 * Two jobs, deliberately both allowed:
 *  - retrieval agents (OAI-SearchBot, Claude-SearchBot, PerplexityBot, …) fetch
 *    a page to answer a live question — these are what earn citations;
 *  - training crawlers (GPTBot, ClaudeBot, Google-Extended, …) feed the model's
 *    background knowledge, which is how an assistant names Rioko with no
 *    retrieval at all.
 *
 * A brand nobody has heard of has nothing to protect by opting out of either.
 *
 * NOTE: this file is not the whole story. Cloudflare prepends its own *managed*
 * robots.txt above ours — disallowing GPTBot, ClaudeBot and Google-Extended —
 * and AI Crawl Control returns 403 to these agents at the edge regardless of
 * what any robots.txt says. Both are dashboard settings, and until they are
 * changed these directives are dead letters. See docs/seo-geo-plan.md §0.
 */
const AI_BOTS = [
    // OpenAI
    "GPTBot",
    "OAI-SearchBot",
    "ChatGPT-User",
    // Anthropic
    "ClaudeBot",
    "Claude-User",
    "Claude-SearchBot",
    "anthropic-ai",
    // Perplexity
    "PerplexityBot",
    "Perplexity-User",
    // Google / Apple / Microsoft AI surfaces
    "Google-Extended",
    "Googlebot",
    "Applebot",
    "Applebot-Extended",
    "Bingbot",
    // Others that ground answers
    "DuckAssistBot",
    "MistralAI-User",
    "Amazonbot",
    "cohere-ai",
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
