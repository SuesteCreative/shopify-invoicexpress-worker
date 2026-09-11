export const runtime = "edge";

import Link from "next/link";
import "./globals.css";
import { sansDisplay, monoFont, generalSans, satoshi } from "./fonts";
import { THEME_BOOTSTRAP_SCRIPT } from "@/lib/theme";

/**
 * The root 404, which has to render its own document.
 *
 * app/layout.tsx is a passthrough returning `children` with no <html> — the
 * locale layout owns the document for /pt and /en, and now the admin layout
 * owns it for /admin. An unmatched URL matches neither, and Next only ever uses
 * the ROOT not-found for one, so without this file a typo under /admin served a
 * page with no <html>, no stylesheet and no fonts.
 *
 * Previously unreachable, which is why it was never missed: a bare /typo used
 * to match the "/:locale" pattern and get locale-redirected into the [locale]
 * tree. /admin is the first surface that bypasses the intl middleware.
 *
 * Also the boundary for notFound() under /admin — a stale dev-mode link to a
 * deleted user is an ordinary, reachable case.
 */
export default function NotFound() {
    return (
        <html
            lang="pt"
            className={`${sansDisplay.variable} ${monoFont.variable} ${generalSans.variable} ${satoshi.variable}`}
            suppressHydrationWarning
        >
            <head>
                <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
            </head>
            <body
                className="antialiased min-h-screen"
                style={{
                    backgroundColor: "var(--background)",
                    color: "var(--foreground)",
                    fontFamily: "var(--app-font-sans), system-ui, sans-serif",
                }}
            >
                <main className="min-h-screen flex flex-col items-center justify-center gap-6 px-6 text-center">
                    <p className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">
                        404
                    </p>
                    <h1 className="text-2xl font-black text-fg">Esta página não existe.</h1>
                    <Link
                        href="/"
                        className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent-ink hover:text-fg transition-colors"
                    >
                        Voltar ao início
                    </Link>
                </main>
            </body>
        </html>
    );
}
