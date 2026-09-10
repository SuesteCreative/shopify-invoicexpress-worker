"use client";

import * as React from "react";
import { Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";

/**
 * The legal links every footer on the site has to carry.
 *
 * There is no shared footer component — the landing, the Shopify landing, the
 * dashboard sidebar, sign-in, sign-up and the onboarding page each roll their
 * own, with their own type ramp. So this carries the links and the hrefs, and
 * takes the styling from whoever renders it. Adding a legal page, or renaming
 * the dispute anchor, is then one edit instead of six.
 *
 * Renders a fragment, so each footer keeps its own flex container and spacing.
 * It is a client component on purpose: four of the six call sites already are,
 * and a client child renders fine inside the two that are server components.
 *
 * Livro de Reclamações is a government site, so it is a plain external anchor;
 * the rest go through the locale-aware Link or they lose the /pt /en prefix.
 */
export function LegalLinks({
    className,
    style,
}: {
    className?: string;
    style?: React.CSSProperties;
}) {
    const t = useTranslations("landing.footer");

    const internal = [
        { key: "privacy", href: "/privacy" },
        { key: "terms", href: "/terms" },
        // An anchor inside the privacy page, matching how kapta.pt does it.
        { key: "disputes", href: "/privacy#litigios" },
    ] as const;

    return (
        <>
            {internal.map(({ key, href }) => (
                <Link key={key} href={href} className={className} style={style}>
                    {t(key)}
                </Link>
            ))}
            <a
                href="https://www.livroreclamacoes.pt/inicio"
                target="_blank"
                rel="noopener noreferrer"
                className={className}
                style={style}
            >
                {t("complaints")}
            </a>
        </>
    );
}
