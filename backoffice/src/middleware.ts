import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";
import { readAccountLanguage } from "./lib/user-language";

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
    "/:locale/lodgify",
    "/:locale/pricing",
    "/:locale/invoicexpress-vs-moloni-vs-vendus",
    // The client-facing onboarding pages: step one is creating the account, so
    // the page itself has to render without one. Every endpoint they call is
    // still behind auth.
    "/:locale/onboarding(.*)",
    // A referral link is handed to someone who has no account yet, by definition.
    // The page reads the code and sends them to sign-up; the claim behind it is
    // still behind auth, and the code alone grants nothing.
    "/:locale/convite(.*)",
    // The campaign terms: read before signing up, and still readable by
    // anyone who took part after it ends.
    "/:locale/campanha-convites",
    "/sign-in(.*)",
    "/sign-up(.*)",
    "/privacy",
    "/terms",
    "/blog(.*)",
    "/shopify",
    "/lodgify",
    "/pricing",
    "/invoicexpress-vs-moloni-vs-vendus",
    "/onboarding(.*)",
    "/convite(.*)",
    "/campanha-convites",
    "/api/webhooks/clerk",
    "/api/webhooks/stripe",
    // Shopify's OAuth redirect. Whoever presses Install is signed in to Shopify,
    // not to Clerk, so there is no session to protect this with: it authenticates
    // itself on the one-shot state plus the HMAC Shopify signs the query with.
    "/api/shopify/oauth/callback",
    "/api/internal/(.*)",
    "/api/cron/(.*)",
    // A newsletter's "Cancelar subscrição". Whoever clicks it may never have had a
    // session; the signed token in the link is the authority, for that one address.
    "/api/newsletter/unsubscribe",
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

/** The admin surface, rioko.online/admin.
 *
 *  Deliberately not locale-prefixed, so the intl middleware must never see it:
 *  with `localePrefix: "always"` it would redirect /admin to /pt/admin, and no
 *  such route exists. Same escape hatch as the crawler files above.
 *
 *  Only a session is required here. The ROLE check lives in app/admin/layout.tsx
 *  because reading D1 from the middleware runtime fails open on purpose (see
 *  isReadOnlyWrite below) — and a gate that fails open is not a gate. */
const isAdminSurface = createRouteMatcher(["/admin(.*)"]);

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

const LOCALE_PREFIX = /^\/(pt|en)(\/|$)/;

/**
 * Put a signed-in client on the language their record says they speak.
 *
 * The URL is still what next-intl renders from — this only decides which URL a
 * merchant lands on, once, before the page is built. Applied to the signed-in
 * surface alone: the marketing pages stay readable in either language by
 * whoever asks for them, which is what their own toggle is for.
 *
 * Not applied while impersonating: an operator reading a client's screen keeps
 * their own choice, and the sidebar toggle writes nothing to the client's row.
 *
 * Fails open, like every other D1 read from this runtime. A dashboard that
 * opens in Portuguese is a wrong language; one that does not open is an outage.
 */
async function languageRedirect(req: NextRequest, userId: string | null | undefined): Promise<URL | null> {
    if (!userId) return null;
    const match = LOCALE_PREFIX.exec(req.nextUrl.pathname);
    if (!match) return null;
    if (req.headers.get("cookie")?.includes("rioko_impersonate_id=")) return null;

    try {
        const { getRequestContext } = await import("@cloudflare/next-on-pages");
        const db = (getRequestContext().env as any)?.DB;
        if (!db) return null;
        const language = await readAccountLanguage(db, userId);
        if (language === match[1]) return null;

        const url = req.nextUrl.clone();
        url.pathname = `/${language}${req.nextUrl.pathname.slice(match[1].length + 1)}`;
        return url;
    } catch {
        return null;
    }
}

export default clerkMiddleware(async (auth, req) => {
    const { pathname } = req.nextUrl;

    if (isCrawlerFile(req)) return;

    // Before isPublicRoute, and that ordering is load-bearing. That list holds
    // "/:locale", whose regex matches ANY single-segment path — /admin included.
    // It is harmless today because a bare /dashboard is only ever a redirect to
    // /pt/dashboard, which is protected. /admin is a real route, so reaching
    // isPublicRoute would skip auth.protect() on the panel's own front door.
    if (isAdminSurface(req)) {
        await auth.protect();
        return;
    }

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

    if (!isPublicRoute(req)) {
        await auth.protect();
        const { userId } = await auth();
        const preferred = await languageRedirect(req, userId);
        if (preferred) return NextResponse.redirect(preferred);
    }
    return intlMiddleware(req);
});

export const config = {
    matcher: [
        "/((?!_next|[^?]*\\.(?:html|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
        "/(api|trpc)(.*)",
    ],
};
