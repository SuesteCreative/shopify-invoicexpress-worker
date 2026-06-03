# GEO content-page system + first batch (plan P1)

> **Why.** LLMs cite *answer-shaped, long-tail content*. Rioko's authority is
> crammed into one landing page (~1k words). This adds a scalable MDX content-page
> system and the first 4 pages, each answering one real query an LLM gets asked.
> Decisions locked: **MDX content system · PT-first (honest hreflang) · all 4 pages.**

---

## Architecture — MDX content-page system

Mirrors the blog (`lib/blog.ts` + `content/blog/*.mdx`), but **per-locale files**
so we never repeat the blog's fake-en mistake (see "Known issue" below).

### New files

1. **`backoffice/content/pages/<slug>.<locale>.mdx`** — one file per (page, locale).
   PT-first → only `.pt.mdx` exist now; dropping a `.en.mdx` later auto-enables EN.
   Frontmatter:
   ```yaml
   title, slug, description
   kind: "use-case" | "comparison"
   date, dateModified?
   heroImage?
   tags?: string[]
   faq?: [{ q, a }]        # feeds BOTH the on-page accordion AND FAQPage schema
   updated?: string         # human "última atualização"
   ```

2. **`backoffice/src/lib/pages.ts`** — registry, like `blog.ts`:
   - `getPage(slug, locale): ContentPage | null`
   - `listPages(locale): ContentPage[]` (only pages with a variant in that locale)
   - `listPageSlugs(): { slug }[]` (for `generateStaticParams`)
   - `localesForSlug(slug): ("pt"|"en")[]` (drives honest hreflang)

3. **`backoffice/src/app/[locale]/guias/[slug]/page.tsx`** — single renderer.
   - `generateStaticParams` from `listPageSlugs()`.
   - **Honest locale guard:** if `getPage(slug, locale)` is null → `notFound()`.
     So `/en/guias/<slug>` 404s until a real `.en.mdx` exists (no duplicate PT-under-/en).
   - `generateMetadata`: canonical `/{locale}/guias/{slug}`; `languages` built from
     `localesForSlug` **only** (+ `x-default` → pt). Never claim a locale we don't have.
   - Renders: header (title, description, updated), `prose-rioko` MDX `<Content/>`,
     `<FaqAccordion>` from frontmatter, CTA, related links.
   - Emits JSON-LD: `articleSchema` (new) + `faqSchema(fm.faq)` + `breadcrumbSchema`.

4. **`backoffice/src/app/[locale]/guias/page.tsx`** — index listing the guides
   (internal-linking hub + crawl surface). Card grid like `blog/page.tsx`.

5. **Components**
   - `backoffice/src/components/FaqAccordion.tsx` — generic client accordion taking
     `items: {q,a}[]` + the `data-faq-question/answer` attrs (speakable). The landing
     `Faq` can later delegate to it (not required now).
   - Comparison tables: **author as Markdown tables in MDX**, styled via `prose-rioko`
     — no new component needed. Add table styles to `prose-rioko` if missing.
   - CTA: small `<GuideCta>` (sign-up button + sign-in link), reused across pages.

6. **`backoffice/src/lib/schema.ts` → new `articleSchema(page, {url, locale})`**
   — schema.org `Article` (not BlogPosting): headline, description, datePublished,
   dateModified, inLanguage, author (Rioko org / Person), publisher, mainEntityOfPage,
   `about` (e.g. "faturação automática"), `isAccessibleForFree: true`.

### Wiring (extend existing, don't rebuild)

- **`sitemap.ts`** — add a `listPages`-driven loop (locale-aware, only real locales),
  `priority: 0.8`, `changeFrequency: "monthly"`. Pattern already there for blog.
- **`llms.txt`** — add a `## Guias` section listing the live guide URLs.
- **`llms-full.txt`** — append the guide titles + descriptions.
- **Nav/footer** — add a "Guias" link (optional, but helps internal linking + crawl).

### URL

`/{locale}/guias/<slug>` — `guias` prefix avoids collisions with `blog`/`privacy`/
`terms`/`sign-in`/`dashboard` and reads well. Slugs:

| # | slug | kind |
|---|------|------|
| 1 | `invoicexpress-vs-moloni-vs-vendus` | comparison |
| 2 | `faturacao-automatica-shopify` | use-case |
| 3 | `faturacao-automatica-stripe` | use-case |
| 4 | `iva-oss-autoliquidacao` | use-case |

---

## First batch — content outlines (PT, ~600–1000 words each)

Each: answer-first H1 + intro, structured H2s, table/steps where relevant, 3–5 FAQ
(frontmatter), internal links (related blog posts + sibling guides), CTA. Honest about
integration status (IX live; Moloni/Vendus roadmap; Stripe-source per note below).

1. **InvoiceXpress vs Moloni vs Vendus (para faturação automática)**
   Intro: which to choose for automating Shopify/Stripe invoicing. Comparison **table**
   (certificação AT, API, séries/ATCUD, notas de crédito, preço, estado no Rioko).
   Per-software section. "Qual escolher" decision guidance. FAQ. CTA.
   *Honesty:* only InvoiceXpress is live in Rioko today; Moloni/Vendus are roadmap.

2. **Faturação automática para Shopify (Portugal)**
   Direct answer to "como emitir faturas automáticas das vendas Shopify". How Rioko
   works (webhook → software certificado em <1s), 3 passos, tratamento fiscal (NIF, IVA
   incluído/separado, ATCUD, M01–M99), "sem extensão no checkout", preço. FAQ. CTA.
   Internal link → ATCUD + séries blog posts.

3. **Faturação automática para Stripe (Portugal)**
   Same shape for Stripe (charges, subscriptions, refunds → fatura / nota de crédito).
   *Honesty flag:* Stripe-source invoicing is currently pilot/pre-access (gated by
   `NEXT_PUBLIC_STRIPE_SOURCE_ENABLED`). Match the landing's framing — present Stripe as
   a supported origin **without overstating** general availability; phrase as
   "disponível / em pré-acesso" consistent with the dashboard copy. Confirm wording with
   Pedro before publish.

4. **IVA OSS e autoliquidação (vendas intra-UE)**
   Explain OSS (B2C intra-UE, limiar 10 000 €) e autoliquidação/reverse charge (B2B
   intra-UE). How Rioko determines country (morada de faturação) and applies the right
   VAT rate + M-code. Worked examples. FAQ. CTA. High E-E-A-T fiscal depth, low comp.

---

## Build order

1. Scaffold the system (steps 1–6 above) with **page 1 (the comparison)** as the first
   real page to prove the pipeline end-to-end.
2. Validate: route renders, 404 on `/en/guias/...`, Rich Results (Article + FAQ +
   Breadcrumb), sitemap + llms include it.
3. Author pages 2–4 (pure `.pt.mdx` additions — zero code).

## Verification

- `/pt/guias/<slug>` renders; `/en/guias/<slug>` → 404 (no fake-en).
- Rich Results Test: Article + FAQPage + BreadcrumbList, 0 errors.
- `sitemap.xml` lists the pt guide URLs with correct hreflang (pt + x-default only).
- `llms.txt` / `llms-full.txt` include the guides.
- `npx tsc -p tsconfig.json` adds no new errors; `npx eslint` clean on new files.

## Known issue to fix separately (not in this batch)

The **blog renders PT content under `/en`** (`getArticleBySlug` returns one MDX
`Content`; `blog/[slug]/page.tsx` has hardcoded PT chrome + pt-PT dates) **yet
`generateMetadata` claims an `en` hreflang alternate**. That's duplicate content +
wrong-language hreflang — a GEO negative. Fix options: (a) make the blog per-locale like
this new system, or (b) drop the `en` alternate + 404 `/en/blog/...` until translated.
Track as its own task.
