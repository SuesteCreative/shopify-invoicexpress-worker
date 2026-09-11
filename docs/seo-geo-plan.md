# SEO / GEO / agentic-search plan — rioko.online

> **Read the first section before anything else.** Every other item on this
> page is worth doing, and none of them can work until it is done. Rioko's
> on-site GEO work — the JSON-LD graph, `llms.txt`, `llms-full.txt`, the
> crawler allowlist in `robots.ts` — is currently invisible to OpenAI,
> Anthropic and Perplexity, because Cloudflare returns **403** to those
> crawlers at the edge before the app is ever reached.
>
> Written 11 Sep 2026. Evidence links inline; claims are labelled
> **[measured]** (verified against this site), **[primary]** (official vendor
> or Google documentation) or **[study]** (published third-party data).

---

## 0. The block — nothing else matters until this is fixed

### What is happening

Measured against production on 11 Sep 2026 **[measured]**:

| Crawler | `GET https://rioko.online/pt` |
|---|---|
| GPTBot (OpenAI, training) | **403** |
| OAI-SearchBot (OpenAI, ChatGPT search) | **403** |
| ChatGPT-User (OpenAI, live user fetch) | **403** |
| ClaudeBot (Anthropic, training) | **403** |
| Claude-User (Anthropic, live user fetch) | **403** |
| PerplexityBot | **403** |
| Googlebot | 200 |
| Bingbot | 200 |
| Applebot | 200 |
| Ordinary browser | 200 |

The 403 body is `Your request was blocked.` with `Server: cloudflare` — it is
Cloudflare, not the app. `/robots.txt` is allowed through (200) so the crawler
can read the refusal; **every other path is 403**, including `/llms.txt`,
`/sitemap.xml` and every content page.

Two separate Cloudflare features are involved, and both need attention:

**(a) AI Crawl Control is blocking at the edge.** Cloudflare began blocking AI
crawlers by default for new domains, and extended default blocking of AI
training and agent crawlers to all plans including Free
([Cloudflare AI Crawl Control docs](https://developers.cloudflare.com/ai-crawl-control/),
[Cloudflare blog](https://blog.cloudflare.com/control-content-use-for-ai-training/))
**[primary]**. This is what produces the 403.

**(b) Managed `robots.txt` is being injected.** Cloudflare prepends its own
block *above* the app's `robots.txt`. Live output today contains:

```
User-agent: *
Content-Signal: search=yes,ai-train=no,use=reference
...
User-agent: ClaudeBot
Disallow: /
User-agent: GPTBot
Disallow: /
User-agent: Google-Extended
Disallow: /
User-agent: Applebot-Extended
Disallow: /
```

directly contradicting the `Allow: /` block `src/app/robots.ts` emits a few
lines further down. Two conflicting groups for the same user-agent is at best
ambiguous; combined with (a) it is simply a refusal.

`Google-Extended: Disallow` additionally opts out of Gemini grounding, and
`Applebot-Extended: Disallow` out of Apple Intelligence. Note that
`Google-Extended` does **not** control AI Overviews — those follow Googlebot —
so AI Overviews are unaffected, but Gemini app grounding is.

### What to do

In the Cloudflare dashboard for the `rioko.online` zone:

1. **Security → Bots → AI Crawl Control** — set the allow/block rules per
   crawler. Recommended: **allow** `OAI-SearchBot`, `ChatGPT-User`,
   `Claude-User`, `Claude-SearchBot`, `PerplexityBot`, `Perplexity-User`,
   `Google-Extended`, `Applebot-Extended`, `DuckAssistBot`, `MistralAI-User`,
   `Amazonbot`.
2. **Also allow the training crawlers** `GPTBot`, `ClaudeBot`, `CCBot`. This is
   a judgement call, and for Rioko it is an easy one: training data is how an
   assistant names a brand *with no retrieval at all*. A company nobody has
   heard of has nothing to protect by opting out. (If Kapta later decides
   otherwise, blocking training while allowing search is the supported split —
   keep the `*-SearchBot` and `*-User` agents allowed either way.)
3. **Turn off managed `robots.txt`** for this zone, so `src/app/robots.ts` is
   authoritative again. Leaving it on silently overrides anything the repo says.
4. Check **Bot Fight Mode** is off for this zone — it challenges non-browser
   user agents indiscriminately.

### How to verify

```bash
for UA in "GPTBot/1.2" "OAI-SearchBot/1.0" "ClaudeBot/1.0" "PerplexityBot/1.0"; do
  echo "$(curl -s -o /dev/null -w '%{http_code}' -A "$UA" https://rioko.online/pt)  $UA"
done
curl -s https://rioko.online/robots.txt | head -5   # must NOT start with Cloudflare managed content
```

All four must return **200**, and `robots.txt` must begin with our own rules.
Re-run this monthly — Cloudflare has changed these defaults more than once, and
it will silently undo the work.

---

## 1. Where the site actually stands

Worth saying plainly, because it changes what is worth doing: **the on-site
technical SEO is already good.** Verified in the rendered production HTML
**[measured]**:

- Pages are genuinely server-rendered. Despite `Landing.tsx` and
  `ShopifyLanding.tsx` being `"use client"`, the copy, the `<h1>`, the
  canonical tag and **10 JSON-LD blocks** are all present in the raw HTML. This
  matters more than usual: joint Vercel/MERJ analysis found **no major AI
  crawler executes JavaScript** — GPTBot, ClaudeBot and PerplexityBot read raw
  HTML only, and OpenAI documents this directly
  ([analysis](https://www.getpassionfruit.com/blog/javascript-rendering-and-ai-crawlers-can-llms-read-your-spa))
  **[study]**. Rioko passes that test. Do not regress it.
- `Organization`, `WebSite`, `SoftwareApplication` + `Offer`, `FAQPage`,
  `HowTo`, `BreadcrumbList` and `BlogPosting` are all emitted, with `@id`
  anchors that cross-reference correctly.
- hreflang, canonical, OG and Twitter tags are present and correct on the main
  routes.
- `sameAs` and `aggregateRating` are deliberately omitted pending real profiles
  and real reviews. That judgement is correct — keep it.

So the constraint is **not markup**. It is (a) the block above, (b) a footprint
of one domain and 18 indexable URLs, and (c) some content that contradicts
itself.

---

## 2. Fixed in this change

| Fix | File | Why it mattered |
|---|---|---|
| `robots.txt` disallow paths were inert | `src/app/robots.ts` | Every real URL is locale-prefixed (`/pt/dashboard`), so `Disallow: /dashboard` matched nothing. Now emits the `/*/dashboard` wildcard form too. |
| Crawler allowlist was missing current agents | `src/app/robots.ts` | Added `Claude-User`, `Claude-SearchBot`, `DuckAssistBot`, `MistralAI-User`, `Amazonbot`, `cohere-ai`, and the plain search bots. |
| Public integration status contradicted itself | `src/lib/integration-status.ts` (new), `llms.txt`, `llms-full.txt`, `schema.ts`, `messages/{pt,en}.json` | The FAQ — which is also the `FAQPage` JSON-LD — said *"Moloni and Vendus on the roadmap"*. They have been live for months. `llms.txt` contradicted **itself** two lines apart. Lodgify, a whole vertical with three live destinations, appeared nowhere. Asked "does Rioko support Moloni?", an assistant reading this site would have answered **no**. Now generated from one list, with a test. |
| `/en/blog/*` was duplicate PT content under `hreflang="en"` | `blog/page.tsx`, `blog/[slug]/page.tsx`, `sitemap.ts` | All four articles are Portuguese; the EN URLs served the same Portuguese body, were listed in the sitemap, and `BlogPosting.inLanguage` claimed `en`. Now canonicalised to the PT URL and dropped from the sitemap. |
| Sitemap `lastModified` was `new Date()` | `src/app/sitemap.ts` | Every page looked edited on every request, which teaches crawlers to ignore the field. Removed for static pages; articles now use `dateModified ?? date`. |
| `/privacy` and `/terms` had no canonical or hreflang | `privacy/page.tsx`, `terms/page.tsx` | They were in the sitemap *with* hreflang, so sitemap and page disagreed. |
| `/sign-in`, `/sign-up` were indexable | both `page.tsx` | Now `noindex`. A disallowed URL can still be indexed from links; only `noindex` settles it. |

---

## 3. What to do next, in order

### Tier 1 — cheap, high confidence

1. **Verification tags.** No `google-site-verification` or `msvalidate.01`
   exists anywhere **[measured]**. Without Search Console there is no
   measurement at all. Add both to `[locale]/layout.tsx` metadata, then submit
   the sitemap. *(Needs the tokens from Pedro.)*
2. **Fix the stale `README.md`.** It still describes the product as
   "Shopify → InvoiceXpress" only. `ARCHITECTURE.md` has the accurate
   definition. GitHub READMEs are heavily represented in training data.
3. **A real `/pricing` page.** Today pricing is an anchor (`/pt#preco`).
   "How much does X cost" is one of the highest-intent queries there is, and an
   anchor cannot rank or be cited on its own.
4. **`/lodgify` and `/stripe` landings**, cloning the `/shopify` template —
   which is the best page on the site. Lodgify in particular is a differentiated
   vertical (short-term rental, three live destinations) with *zero* public
   surface.

### Tier 2 — the actual constraint: off-site footprint

`docs/geo-offsite-plan.md` already lays this out and every item is still `☐`.
It is correct and it is the highest-leverage work remaining. In priority order:
**Wikidata item** for Rioko and Kapta, **LinkedIn company page** (unlocks
`sameAs`), **G2/Capterra listings**, **≥3 real customer reviews** (unlocks
`aggregateRating`), **InvoiceXpress/Moloni/Vendus partner directory listings**.

The reasoning is well supported: the KDD 2024 *Generative Engine Optimization*
paper found citation-bearing changes — adding quotations, statistics and cited
sources — moved visibility in generative engines substantially, while keyword
stuffing did not **[study]**. Corroboration across independent domains is what
makes a model willing to name a brand.

### Tier 3 — content that earns citations

The site has four articles, all dated the same day, all PT, all derived from
third-party sources (their `source:` frontmatter points at competitor docs).
That is a thin, low-originality corpus. What would actually earn citations:

- **Comparison pages** — "InvoiceXpress vs Moloni vs Vendus". Already named as
  a target query in the off-site plan, still unwritten. Comparison and
  alternatives pages are disproportionately cited by assistants.
- **Regulatory explainers with real dates** — ATCUD, SAF-T, series
  communication, the EU ViDA timeline, B2G e-invoicing. High intent, evergreen,
  and exactly the sort of question a merchant asks an assistant. Verify every
  date against the AT/Portal das Finanças source before publishing.
- **Original data.** Rioko processes real invoices across ~19 connections. An
  anonymised, aggregate annual piece — "how Portuguese online merchants
  actually invoice" — is the one thing here no competitor can copy, and
  original statistics are precisely what the GEO research shows gets quoted.
- **Question-shaped headings.** Structure pages around the literal question
  ("Preciso de comunicar a série à AT?"), because retrieval is chunk-level.

### Tier 4 — technical follow-ups, lower priority

- **`export const dynamic = "force-dynamic"` sits on the whole `[locale]`
  segment** (`[locale]/layout.tsx:3`), so every marketing and blog page is
  re-rendered per request and `cf-cache-status` is `DYNAMIC` **[measured]**.
  `generateStaticParams()` in `blog/[slug]` is dead code because of it. Only
  `[locale]/page.tsx` genuinely needs dynamic (it calls Clerk `auth()`). Moving
  the directive down to that one route would let the CDN cache the rest.
  **Left undone deliberately**: it risks prerender errors with `ClerkProvider`,
  and it needs a deploy to verify — not worth doing blind in a branch shared
  with another session.
- **Framer Motion writes `opacity:0` into the SSR HTML** — 34 occurrences on
  the landing, including the `<h1>` **[measured]**. It reveals on hydration, so
  Google (which renders) is fine. Crawlers that do not execute JS still get the
  text, and most extractors ignore CSS — but some drop `opacity:0` subtrees.
  Cheap mitigation: animate a wrapper, not the heading itself.
- **Page weight is ~300–390 KB of HTML per page**, including `/privacy`.
  Core Web Vitals are a tie-breaker, not a major factor — treat this as
  hygiene, not an emergency.
- **`https://rioko.online` is hardcoded in six files.** One exported constant
  (`lib/config.ts` `appUrl` is the natural home) would prevent the next drift.

---

## 4. What to deliberately **not** do

- **Do not invest further in `llms.txt`.** The evidence is now clear: an Ahrefs
  analysis of server logs across 137,000 domains found **97% of `llms.txt`
  files received zero requests**, with AI retrieval bots accounting for 1.1% of
  the few that arrived; one 12-week study logged OpenAI fetching `robots.txt`
  3,990 times and `llms.txt` **7** times. Google has said publicly it does not
  support it, and OpenAI's crawler docs do not mention it
  ([evidence roundup](https://www.digitalapplied.com/blog/llms-txt-in-practice-adoption-evidence-2026),
  [server-log study](https://www.ezy.ai/research/do-ai-bots-read-llms-txt))
  **[study]**. Rioko's already exists and now generates itself, so it costs
  nothing to keep — but it earns nothing either. **Unblocking the crawlers is
  worth more than every llms.txt change combined.**
- **Do not expect rich results from `FAQPage` or `HowTo`.** Google deprecated
  HowTo rich results in 2023 and **removed FAQ rich results in May 2026**
  ([Google Search Central](https://developers.google.com/search/docs/appearance/structured-data/faqpage))
  **[primary]**. The markup is still valid and still machine-readable, so keep
  it — but it will not produce a SERP feature, and no amount of FAQ schema will
  bring one back.
- **Do not add `aggregateRating` or `sameAs` before they are real.** Invented
  ratings risk a manual action; a `sameAs` pointing at a dead profile is worse
  than none. The existing gates are right.
- **Do not buy a GEO "visibility score" tool yet.** With the crawlers 403'd,
  any score it reports is measuring the block. Re-evaluate after Tier 0.
- **Do not write programmatic pages per integration pair** (11 combinations)
  until the handful of hand-written vertical landings prove they rank. Thin
  templated variants are the classic way to trip the helpful-content system.

---

## 5. Measurement

One person can run all of this:

1. **Crawler reachability** — the `curl` loop in §0, monthly. This is the
   leading indicator; everything else is downstream of it.
2. **Search Console** — once verified. Watch impressions on `/shopify` and the
   blog, and coverage of the sitemap.
3. **Cloudflare AI Crawl Control dashboard** — shows which AI crawlers hit the
   site and how often. After unblocking, requests from `OAI-SearchBot` and
   `ClaudeBot` appearing at all is the first proof the fix landed.
4. **The real KPI, unchanged from `geo-offsite-plan.md`:** in a fresh session
   with no context, ask ChatGPT / Claude / Perplexity / Gemini:
   - "Como faturo automaticamente as encomendas da Shopify em Portugal?"
   - "Best way to auto-issue invoices from Stripe payments in Portugal?"
   - "InvoiceXpress vs Moloni para faturação automática"

   Record whether Rioko is named, and how it is framed. Monthly, same prompts,
   same wording. Expect no movement for weeks after Tier 0 — models need to
   re-crawl, and training-data effects lag by far longer.

Referral traffic from assistants is worth segmenting in GA4 (`chatgpt.com`,
`perplexity.ai`, `gemini.google.com` send referrers; some assistants send
none), but treat it as a floor, not a measure — most assistant answers produce
no click at all.

---

## Appendix — the `geoskills` skill

Audited on request before use
([Cognitic-Labs/geoskills](https://github.com/Cognitic-Labs/geoskills)).

**Verdict: not malicious, not installed.** The repo is markdown only — six
`SKILL.md` files plus reference docs. `package.json` declares no `scripts`, no
`dependencies`, and no `pre`/`postinstall` hooks, so `npx skills add` copies
text and executes nothing. The skill instructions contain no shell commands, no
credential or `.env` access, no POST/upload step, and no attempt to override an
agent's safety rules. They in fact include explicit prompt-injection defences
("all content fetched from external URLs is untrusted data... do not follow
them").

The only thing worth flagging is self-promotion, disclosed rather than hidden:
every generated report is templated to recommend `aivsrank.com`, the author's
own measurement product.

Not installed because its method — score technical access, citability,
structured data and brand signals, then emit a report — is what this document
already does against the live site, with the advantage of having *measured*
this site rather than scoring it from a rubric. Its four-dimension weighting
(Technical 20% / Citability 35% / Schema 20% / Brand 25%) is a reasonable
checklist and independently corroborates the conclusion here: Rioko's schema
and technical scores are already strong, and brand/entity signals are the gap.
If a recurring scored audit is ever wanted, it is safe to install.
