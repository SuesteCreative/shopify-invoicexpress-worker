"use client";

import * as React from "react";
import { Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";

/**
 * The page links every footer carries, so the content pages are not orphans.
 *
 * /shopify, /lodgify, /pricing and the comparison shipped reachable only from
 * the sitemap. A sitemap tells a crawler a URL exists; an internal link is what
 * tells it the URL matters, and is how a reader finds it at all. Four pages
 * with no inbound link from the site's own pages were being asked to rank on
 * nothing.
 *
 * Same shape and reasoning as LegalLinks: a fragment, so each footer keeps its
 * own container and type ramp, and a client component because most call sites
 * already are.
 */
export function SiteLinks({
    className,
    style,
}: {
    className?: string;
    style?: React.CSSProperties;
}) {
    const t = useTranslations("landing.footer");

    const links = [
        { href: "/shopify", label: t("navShopify") },
        { href: "/lodgify", label: t("navLodgify") },
        { href: "/pricing", label: t("navPricing") },
        { href: "/invoicexpress-vs-moloni-vs-vendus", label: t("navCompare") },
        { href: "/blog", label: t("navBlog") },
    ] as const;

    return (
        <>
            {links.map((l) => (
                <Link
                    key={l.href}
                    href={l.href as never}
                    className={className}
                    style={style}
                >
                    {l.label}
                </Link>
            ))}
        </>
    );
}
