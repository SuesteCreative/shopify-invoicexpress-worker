import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

const intlMiddleware = createIntlMiddleware(routing);

const isPublicRoute = createRouteMatcher([
    "/",
    "/:locale",
    "/:locale/sign-in(.*)",
    "/:locale/sign-up(.*)",
    "/:locale/privacy",
    "/:locale/terms",
    "/:locale/blog(.*)",
    "/:locale/shopify",
    "/sign-in(.*)",
    "/sign-up(.*)",
    "/privacy",
    "/terms",
    "/blog(.*)",
    "/shopify",
    "/api/webhooks/clerk",
    "/api/webhooks/stripe",
    "/api/internal/(.*)",
    "/api/cron/(.*)",
]);

// Root-level crawler/SEO endpoints served by app routes. They must bypass the
// intl middleware — otherwise it locale-redirects them (/llms.txt →
// /pt/llms.txt → 404) and search engines / AI crawlers get nothing.
const isCrawlerFile = createRouteMatcher([
    "/llms.txt",
    "/llms-full.txt",
    "/sitemap.xml",
    "/robots.txt",
]);

/** A read-only extra user (migration 0039) may call any GET and no write. The
 *  authoritative check lives in resolveAccountUser(); this one only turns it into
 *  a clean 403 before the route runs, and skips itself if D1 is unreachable from
 *  the middleware runtime. */
async function isReadOnlyWrite(req: Request, userId: string | null | undefined): Promise<boolean> {
    if (!userId) return false;
    if (["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase())) return false;
    try {
        const { getRequestContext } = await import("@cloudflare/next-on-pages");
        const db = (getRequestContext().env as any)?.DB;
        if (!db) return false;
        const row: any = await db
            .prepare("SELECT role FROM account_members WHERE member_user_id = ? AND status = 'active' LIMIT 1")
            .bind(userId)
            .first();
        return row?.role === "viewer";
    } catch {
        return false;
    }
}

export default clerkMiddleware(async (auth, req) => {
    const { pathname } = req.nextUrl;

    if (isCrawlerFile(req)) return;

    if (pathname.startsWith("/api")) {
        if (!isPublicRoute(req)) {
            await auth.protect();
            const { userId } = await auth();
            if (await isReadOnlyWrite(req, userId)) {
                return new Response(JSON.stringify({ error: "read_only_member" }), {
                    status: 403,
                    headers: { "content-type": "application/json" },
                });
            }
        }
        return;
    }

    if (!isPublicRoute(req)) await auth.protect();
    return intlMiddleware(req);
});

export const config = {
    matcher: [
        "/((?!_next|[^?]*\\.(?:html|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
        "/(api|trpc)(.*)",
    ],
};
