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
    "/sign-in(.*)",
    "/sign-up(.*)",
    "/privacy",
    "/terms",
    "/api/webhooks/clerk",
    "/api/webhooks/stripe",
    "/api/internal/(.*)",
    "/api/cron/(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
    const { pathname } = req.nextUrl;

    if (pathname.startsWith("/api")) {
        if (!isPublicRoute(req)) await auth.protect();
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
