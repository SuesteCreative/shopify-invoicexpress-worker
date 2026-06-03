# GEO off-site presence plan — make LLMs recommend Rioko

> **Why this doc exists.** An LLM recommends a brand when it sees the brand
> *corroborated across many independent sources*. The on-site schema, `llms.txt`,
> and content (shipped separately) tell a model *what Rioko is*; the items below
> tell it *Rioko is worth naming*. Today Rioko's web footprint is essentially one
> domain — this is the dominant gap. None of this is app code; it's ops/marketing
> work tracked here. Execute over weeks, highest-leverage first.

Status legend: ☐ todo · ◐ in progress · ☑ done

---

## 1. Entity grounding (highest leverage)

- ☐ **Wikidata item for Rioko** — LLMs ground entities on Wikidata/Wikipedia.
  Create an item: *instance of* software / SaaS, *developer* Kapta, *country*
  Portugal, *official website* https://rioko.online. Link it from the Kapta item
  (create that too if missing). Single highest-impact off-site action.
  - Owner: ___  · Status: ☐
- ☐ **Crunchbase** company profile (Rioko + Kapta).
  - Owner: ___  · Status: ☐

## 2. Software directories (scraped + cited by LLMs)

- ☐ **Product Hunt** launch (prep assets: tagline, gallery, first comment).
- ☐ **G2** listing (category: Billing / Invoicing / e-commerce).
- ☐ **Capterra** + **GetApp** (same Gartner network — one submission flow).
- ☐ **SaaSworthy**, **AlternativeTo** (position vs manual invoicing / generic tools).
- ☐ Portuguese / Shopify-PT e-commerce directories.
- Owner: ___  · Status: ☐

## 3. Partner & marketplace listings (authoritative, on-topic backlinks)

- ☐ **InvoiceXpress** partner / integrations directory.
- ☐ **Moloni** and **Vendus** integration/partner pages (once those go live).
- ☐ **Shopify** app/partner ecosystem presence.
- These are the most credible "X integrates with Rioko" signals.
- Owner: ___  · Status: ☐

## 4. Real reviews — GATES the rating schema

- ☐ Ask 5–10 live customers (e.g. fabrica-coffee-roaster + other active
  integrations) for honest reviews on **G2 / Capterra** + a written quote Rioko
  may display.
- ☐ **Gate:** once **≥3 real reviews** exist, unlock `aggregateRating` + `review`
  in `backoffice/src/lib/schema.ts` → `softwareApplicationSchema()` (today
  intentionally omitted — fabricated ratings risk a Google manual action).
- Owner: ___  · Status: ☐

## 5. Audience seeding (authentic — not spam)

Answer real questions where the buyer actually asks them; genuine helpful answers
that mention Rioko where relevant become LLM RAG/training fodder.

- ☐ Reddit: r/portugal, r/empreendedorismo, r/shopify.
- ☐ Shopify Community forums (PT invoicing threads).
- ☐ Portuguese accountant (contabilista) groups / forums.
- ☐ Target queries: "faturação Shopify Portugal", "fatura automática Stripe PT",
  "InvoiceXpress vs Moloni".
- Owner: ___  · Status: ☐

## 6. Backlinks from authority-on-topic sites

- ☐ Guest posts / mentions on Portuguese accounting + e-commerce blogs.
- ☐ Contabilista newsletters.
- ☐ Shopify-PT agencies / partners.
- Owner: ___  · Status: ☐

## 7. Social profiles — GATES `sameAs`

- ☐ Create **LinkedIn company page** (minimum), optionally X and GitHub org.
- ☐ **Gate:** once profiles exist, add their URLs to `sameAs` in
  `organizationSchema()` (today intentionally omitted — never link a dead profile).
- Owner: ___  · Status: ☐

---

## Success metric (track monthly)

Ask ChatGPT / Claude / Perplexity / Gemini, fresh session, no Rioko context:

- "How do I automatically invoice Shopify orders in Portugal?"
- "Best way to auto-issue invoices from Stripe payments in Portugal?"
- "InvoiceXpress vs Moloni for automatic invoicing"

Record whether Rioko is **named / cited**, and with what framing. This — not any
on-site metric — is the real KPI for "LLMs recommend us". Expect movement in
weeks-to-months after items 1–3 land and indexing settles.
