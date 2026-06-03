/**
 * Content-page registry (use-case / comparison "guias").
 *
 * Mirrors `lib/blog.ts` but is PER-LOCALE: each entry is one (slug, locale)
 * pair backed by `content/pages/<slug>.<locale>.mdx`. A page only exists for the
 * locales that have a real file — so the renderer can 404 untranslated locales
 * and emit honest hreflang (never claim a locale we haven't actually written).
 *
 * To add a page: write `content/pages/<slug>.<locale>.mdx` with frontmatter,
 * then add an entry to REGISTRY below.
 */

import type { ComponentType } from "react";

export type Locale = "pt" | "en";
export type FaqItem = { q: string; a: string };

type RawFrontmatter = {
    title: string;
    slug: string;
    description: string;
    kind: "use-case" | "comparison";
    date: string;
    dateModified?: string;
    updated?: string;
    tags?: string[];
    heroImage?: string;
    faq?: FaqItem[];
};

export type ContentPage = RawFrontmatter & {
    locale: Locale;
    Content: ComponentType;
};

type Mod = { default: ComponentType; frontmatter: RawFrontmatter };

import * as IxVsMoloniVsVendusPt from "../../content/pages/invoicexpress-vs-moloni-vs-vendus.pt.mdx";

const REGISTRY: Array<{ locale: Locale; mod: Mod }> = [
    { locale: "pt", mod: IxVsMoloniVsVendusPt as unknown as Mod },
];

function toPage(entry: { locale: Locale; mod: Mod }): ContentPage {
    return { ...entry.mod.frontmatter, locale: entry.locale, Content: entry.mod.default };
}

/** A page variant for a specific locale, or null if not translated yet. */
export function getPage(slug: string, locale: string): ContentPage | null {
    const found = REGISTRY.find(
        (e) => e.mod.frontmatter.slug === slug && e.locale === locale
    );
    return found ? toPage(found) : null;
}

/** All pages that exist in a given locale, newest first. */
export function listPages(locale: string): ContentPage[] {
    return REGISTRY.filter((e) => e.locale === locale)
        .map(toPage)
        .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** Distinct slugs across all locales (for generateStaticParams). */
export function listPageSlugs(): string[] {
    return Array.from(new Set(REGISTRY.map((e) => e.mod.frontmatter.slug)));
}

/** Locales a given slug actually has — drives honest hreflang alternates. */
export function localesForSlug(slug: string): Locale[] {
    return REGISTRY.filter((e) => e.mod.frontmatter.slug === slug).map((e) => e.locale);
}
