/**
 * Blog article registry.
 *
 * Each entry imports an MDX file (`backoffice/content/blog/<slug>.mdx`) and
 * grabs both the rendered component (default export) and the frontmatter
 * (named export provided by `remark-mdx-frontmatter`).
 *
 * To add a new article: write the .mdx file with frontmatter, then add an
 * entry to ARTICLES below. Sort is reverse-chronological at runtime.
 */

import type { ComponentType } from "react";

type RawFrontmatter = {
    title: string;
    slug: string;
    description: string;
    date: string;
    dateModified?: string;
    author?: string;
    tags?: string[];
    category?: string;
    readingMinutes?: number;
    source?: string;
    heroImage?: string;
};

export type Article = RawFrontmatter & {
    Content: ComponentType;
};

import * as ATCUD from "../../content/blog/atcud-criar-utilizador-autoridade-tributaria.mdx";
import * as Series from "../../content/blog/series-faturacao-o-que-sao-como-comunicar.mdx";
import * as SerieMoloni from "../../content/blog/como-criar-serie-faturacao-moloni.mdx";
import * as SerieVendus from "../../content/blog/como-criar-serie-faturacao-vendus.mdx";

const REGISTRY: Array<{ default: ComponentType; frontmatter: RawFrontmatter }> = [
    ATCUD as any,
    Series as any,
    SerieMoloni as any,
    SerieVendus as any,
];

function toArticle(m: { default: ComponentType; frontmatter: RawFrontmatter }): Article {
    return { ...m.frontmatter, Content: m.default };
}

export function listArticles(): Article[] {
    return REGISTRY
        .map(toArticle)
        .sort((a, b) => (a.date < b.date ? 1 : -1));
}

export function getArticleBySlug(slug: string): Article | null {
    const found = REGISTRY.find((m) => m.frontmatter.slug === slug);
    return found ? toArticle(found) : null;
}

export function listSlugs(): string[] {
    return REGISTRY.map((m) => m.frontmatter.slug);
}
