export const runtime = "edge";
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { ClerkProvider } from "@clerk/nextjs";
import { ptPT } from "@clerk/localizations";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";

import { sansDisplay, monoFont, generalSans, satoshi } from "../fonts";
import { THEME_BOOTSTRAP_SCRIPT } from "@/lib/theme";
import { getRole } from "@/lib/admin";
import InactivityLogout from "@/components/InactivityLogout";
import { ImpersonationBanner } from "@/components/ImpersonationBanner";
import { AdminSidebar } from "@/components/admin/AdminSidebar";

// A metadata OBJECT is always safe here. A metadata FILE (icon.*, apple-icon.*,
// opengraph-image.*) anywhere under this tree is not: nested, Next emits a
// per-route prerender config that next-on-pages rejects, `next build` says
// nothing, and Cloudflare quietly keeps serving the previous deploy.
export const metadata: Metadata = {
    title: "Rioko Admin",
    robots: { index: false, follow: false },
};

// Internal surface, Portuguese only. Fixing the locale is what lets every moved
// panel keep its useTranslations() calls without a single edit: they only need
// a provider in scope, not a [locale] segment above them.
const ADMIN_LOCALE = "pt";

/**
 * The root layout is a passthrough with no <html>, so this surface owns its own
 * document — deliberately a smaller one than the merchant app's. No GA (admin
 * traffic is not analytics), no consent banner (nothing here sets a marketing
 * cookie), no attribution capture, no JSON-LD.
 *
 * The role gate lives here rather than in the middleware: it covers every child
 * route including the client-rendered panels, which cannot guard themselves,
 * and one getRole() read answers both questions the page needs — may they be
 * here, and are they hiperadmin.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
    const { userId } = await auth();
    const role = userId ? await getRole(userId) : "user";
    if (role !== "superadmin" && role !== "hiperadmin") redirect("/dashboard");

    const messages = await getMessages({ locale: ADMIN_LOCALE });

    return (
        <ClerkProvider localization={ptPT}>
            <html
                lang={ADMIN_LOCALE}
                className={`${sansDisplay.variable} ${monoFont.variable} ${generalSans.variable} ${satoshi.variable}`}
                suppressHydrationWarning
            >
                <head>
                    {/* Paints the chosen skin before the first frame, so the
                        panel never flashes the other palette. Cosmetic only. */}
                    <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
                </head>
                <body
                    className="antialiased min-h-screen overflow-x-hidden"
                    style={{
                        backgroundColor: "var(--background)",
                        color: "var(--foreground)",
                        fontFamily: "var(--app-font-sans), system-ui, sans-serif",
                    }}
                >
                    <NextIntlClientProvider locale={ADMIN_LOCALE} messages={messages}>
                        <InactivityLogout />
                        <div className="brand-ambient" aria-hidden="true" />

                        {/* Not decoration. /api/admin/users answers as the
                            IMPERSONATED user on purpose, so an admin who forgot
                            they were impersonating sees a silently shortened
                            client list — and, without this, no way back out of
                            it from here. A row of its own above the sidebar, so
                            it takes real height instead of covering the page. */}
                        <div className="flex flex-col h-screen overflow-hidden">
                            <ImpersonationBanner />
                            <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-hidden">
                                <AdminSidebar isHiperadmin={role === "hiperadmin"} />
                                <main className="flex-1 overflow-y-auto relative z-10 px-4 py-6 md:px-12 md:py-16">
                                    {children}
                                </main>
                            </div>
                        </div>
                    </NextIntlClientProvider>
                </body>
            </html>
        </ClerkProvider>
    );
}
