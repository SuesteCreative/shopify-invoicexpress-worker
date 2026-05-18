# Rioko 2.0 — Brand & Landing Style Guide

> Reference for everything visual on the public landing page (`rioko.online/`).
> Source of truth lives at [`backoffice/src/components/landing/Landing.tsx`](../backoffice/src/components/landing/Landing.tsx).
> When in doubt, the file wins.

## 1. Brand essence

Rioko is the **Hub de Integrações** that turns paid orders from any storefront/gateway into compliant Portuguese invoices in any invoicing program — in < 1 second.

The visual language pulls from Stripe Apps + Raycast + Linear: lighter-dark surface, layered glass depth, single high-energy accent, perpetual micro-motion. **Avoid editorial luxury, avoid AI-slop purple/sky glow.**

---

## 2. Color tokens

### Surfaces

| Token | Hex | Usage |
|---|---|---|
| `SURFACE` | `#0E1116` | Page background. Body chrome override target. |
| `SURFACE_2` | `#14181F` | Lifted dark tiles inside dark cards. |
| `PAPER` | `#EAEAE4` | Warm dim off-white. **Cards hosting platform logos** (rotating flow cards + matrix integration cards). |
| `PAPER_HOVER` | `#F3F3ED` | Paper card hover brighten target. |

### Foreground

| Token | Value | Usage |
|---|---|---|
| `FG` | `#F0F0F0` | Primary text on dark surfaces. |
| `FG_60` | `rgba(240,240,240,0.62)` | Secondary text on dark. Body copy, muted lines. |
| `FG_40` | `rgba(240,240,240,0.40)` | Tertiary on dark. Eyebrows, mono micro-labels. |
| `INK` | `#14181F` | Primary text on paper. |
| `INK_60` | `rgba(20,24,31,0.62)` | Secondary text on paper. |
| `INK_40` | `rgba(20,24,31,0.42)` | Tertiary on paper. |

### Rules & hairlines

| Token | Value | Usage |
|---|---|---|
| `RULE` | `rgba(255,255,255,0.08)` | Section dividers, eyebrow borders on dark. |
| `HAIRLINE` | `rgba(255,255,255,0.06)` | Inner card borders on dark. |
| `PAPER_RULE` | `rgba(0,0,0,0.06)` | Card borders on paper. |

### Accent (single brand color family)

| Token | Hex | Usage |
|---|---|---|
| `ACCENT` | `#028DC4` | Rioko brand cyan. Matches the 2.0 pill in the logo SVG. Primary CTA in dark contexts, engine card gradient base, status badges (live, deep), price card highlights. |
| `ACCENT_HOT` | `#5EEAD4` | Mint accent. Live dots, success ticks, body-copy emphasis, flow connector dots, engine pipeline checkmarks. Used when `#028DC4` would read too dark on charcoal at small size. |
| `SOON` | `#F59E0B` | Amber. **Only** for "Em breve" status badges. |

### Headline gradient

```css
background-image: linear-gradient(135deg, #06B6D4 0%, #028DC4 55%, #0369A1 100%);
```

Cyan → brand → deeper blue. Used exclusively for **noun accent words** in section/hero headlines (e.g. `fatura`, `encomenda`, `plataforma`, `Rioko`, `Uma vez.`, `quatro`, `Por integração.`, `Não`). **Never** on body text (< 24px reads fuzzy on Windows ClearType).

### Forbidden palettes

- **Purple / lila** of any kind (`#A855F7`, `#635BFF` outside the Stripe brand monogram tile, etc.) — reads as AI slop.
- **Sky-blue glow halos** (`box-shadow: 0 0 40px ...rgba(14,165,233,...)`) — the slop signature the brief replaced.
- **Oversaturated neon emerald/cyan** — reserve mint `#5EEAD4` for sparingly used live indicators.
- Pure `#000000` backgrounds.

---

## 3. Typography

### Fonts

| Role | Font | Weight | Where |
|---|---|---|---|
| Display / headline | **Geist Sans** (`var(--font-sans-display)`) | 500 | All `h1` / `h2` / `h3` on landing |
| Body | **Geist Sans** | 400 | Paragraphs, captions |
| Mono | **Geist Mono** (`var(--font-mono)`) | 400 / 500 | Eyebrows, stats, code, status pills, micro-labels |

Loaded via `next/font/google` in [`backoffice/src/app/fonts.ts`](../backoffice/src/app/fonts.ts). Variables applied at the `<Landing>` wrapper.

### Banned fonts

- **Inter** (the AI-slop tell)
- Roboto, Open Sans, Arial, Helvetica, system-ui defaults
- Any serif (current design has no editorial serif — that was the cozy-editorial version that got rejected)

### Type scale

| Role | Size | Line-height | Tracking |
|---|---|---|---|
| Hero h1 | `clamp(2.5rem, 6vw, 5.5rem)` | `0.97` | `-0.025em` |
| Section h2 | `clamp(2.25rem, 4vw, 3.75rem)` | `1.02` | `-0.025em` |
| Step h3 | `clamp(2rem, 3.4vw, 3rem)` | `1.02` | `-0.025em` |
| Final CTA h2 | `clamp(2.5rem, 5vw, 4.75rem)` | `0.98` | `-0.025em` |
| Pricing tier price | `clamp(2.5rem, 4vw, 3.5rem)` | `1` | `-0.03em` |
| Card title | `18px` | tight | tight |
| Body | `15px–16px` | `1.55–1.6` | normal |
| Eyebrow / micro-mono | `10–11px` uppercase | normal | `0.18em–0.24em` |

### Treatments

- **Accent words in headlines** → wrap in `<Gradient>` (see `Landing.tsx`). Geist Sans inherited from parent, cyan gradient via `background-clip: text`. Used everywhere the page wants to emphasize a noun.
- **Body emphasis** → solid color span (`ACCENT_HOT` mint), not gradient. Example: `"Webhook entra, <span style={{color: ACCENT_HOT}}>fatura sai</span>"`.
- **Numbers** → always `font-mono` + `tabular-nums` (`tabular-nums` class). Latencies, prices, dates, IDs.
- **Eyebrow tags** → mono, uppercase, `tracking-[0.18em-0.24em]`, prefixed with a 1×1 colored dot.

---

## 4. Surfaces & elevation

### Glass card recipe (dark contexts)

Applied to: hero showcase outer, code panel containers in HowItWorks, fiscal cells, integration request bar, nav pill, pricing non-highlight cards.

```css
background:            rgba(255, 255, 255, 0.03);
border:                1px solid rgba(255, 255, 255, 0.06);
backdrop-filter:       blur(20px);
-webkit-backdrop-filter: blur(20px);
box-shadow:
  inset 0 1px 0 rgba(255, 255, 255, 0.06),   /* inner top highlight  */
  0 24px 48px -28px rgba(0, 0, 0, 0.6);      /* tinted outer shadow  */
border-radius:         1.5rem;                /* tighter than editorial */
```

### Paper card recipe (logo hosts)

Used for: rotating flow cards (origin/destination), matrix integration cards.

```css
background:    #EAEAE4;
border:        1px solid rgba(0, 0, 0, 0.06);
box-shadow:
  inset 0 1px 0 rgba(255, 255, 255, 0.70),
  0 14px 28px -18px rgba(0, 0, 0, 0.55);
border-radius: 1.25rem (matrix) / 1rem inner (flow);
```

Platform logos sit **transparently** on top — never inside a separate white chip. The paper bg provides the contrast for mixed-fill wordmarks (easypay/eupago/moloni/invoicexpress all have dark portions that need a light backdrop).

### Engine card recipe (the one cyan moment in the showcase)

```css
background:
  linear-gradient(135deg, #028DC4 0%, #0369A1 100%);
color: #FFFFFF;
box-shadow:
  inset 0 1px 0 rgba(255,255,255,0.15),
  0 0 40px -10px rgba(2,141,196,0.55),     /* cyan glow ring */
  0 12px 30px -16px rgba(0,0,0,0.6);
border-radius: 1rem;
```

### Final CTA recipe (the second cyan moment)

```css
background:
  linear-gradient(135deg, #0A0A0A 0%, #14181F 60%, #0A2540 100%);
box-shadow:
  inset 0 1px 0 rgba(255,255,255,0.06),
  inset 0 0 0 1px rgba(2,141,196,0.18);     /* cyan rim */
border-radius: 2rem;
```

### Double-bezel shell (Doppelrand)

When a card needs visual weight, wrap it in a thin padded wrapper at the next-lighter tone (concentric radii):

```html
<div className="rounded-[1.75rem] p-1.5"
     style="background: rgba(255,255,255,0.04)">
  <div className="rounded-[calc(1.75rem-0.375rem)]" style="...inner...">
  </div>
</div>
```

---

## 5. Motion

### Easing

```ts
const EASE: [number, number, number, number] = [0.32, 0.72, 0, 1];
// equivalent: cubic-bezier(0.32, 0.72, 0, 1)
```

The single canonical easing. Used on every transition. Never `linear`, never `ease-in-out`.

### Durations

| Use | Duration |
|---|---|
| Hover state changes (color, ring opacity) | `500ms` |
| Carousel slot enter | `500ms` |
| Carousel slot exit | `120ms` (opacity-only fade-out to prevent mid-rotation blank) |
| Hero load-in cascade | `600–1000ms`, stagger 80–200ms |
| Scroll-reveal in-view | `700–800ms` |
| Engine pipeline pill stagger | `70ms` per pill (spring) |
| Flow connector dot loop | `0.9s` linear infinite |
| Live dot ping | `2s` infinite ease-out |

### Spring physics (Framer Motion)

For tactile elements (engine pills on rotation, pricing card hover lift):

```ts
{ type: "spring", stiffness: 220, damping: 14 }
```

### Performance rules

- **Only animate `transform` + `opacity`** (and `filter: blur` for atmospheric reveals). Never `top/left/width/height`.
- **Perpetual loops** must be isolated in their own memoized client component so they don't trigger parent re-renders. Example: `RotatingFlowCard` is `React.memo`'d and the parent (`HeroShowcase`) owns the timer.
- **CSS keyframes** for pure GPU loops (flow connector). Defined inline via `<style>` tag at the root of the landing component:
  ```css
  @keyframes rk-flow-down {
    from { background-position-y: 0px; }
    to   { background-position-y: 8px; }
  }
  ```
- **AnimatePresence** for crossfade carousels uses `mode="wait"` with a short exit (`120ms` opacity-only) and a longer entrance (`500ms` y+blur). Avoids the mid-transition blank gap.
- **Reduced motion** — currently not gated. If added later: bypass perpetual loops + scroll reveals when `prefers-reduced-motion: reduce`.

### Button physics

Every CTA has the same magnetic tactile treatment:

- Outer pill (`rounded-full`, `py-3 pl-6 pr-2`)
- Trailing arrow nested inside its own circle (`h-7 w-7 rounded-full`) flush with the right edge
- `active:scale-[0.98]` for the physical press
- On `group-hover`: arrow circle `translate-x-[1-2px] translate-y-[-1px]` — creates internal kinetic tension
- Tinted box-shadow matching the button background (`rgba(2,141,196,0.55)` for cyan, dark for white)

---

## 6. Components

### Status badge (3 states)

| State | Bg | Fg | Dot |
|---|---|---|---|
| `live` | `rgba(2,141,196,0.12)` | `#0369A1` | `#0369A1` 1.5×1.5 px |
| `soon` | `rgba(154,106,31,0.14)` | `#7C4A0F` | — |
| `planned` | `rgba(20,24,31,0.08)` | `INK_60` | — |

Mono uppercase, `tracking-[0.18em]`, `text-[10px]`, padded `px-2 py-0.5`.

### Brand logo container (BrandLogo)

Transparent shell sized to host any platform wordmark via `object-contain`. Width × height fixed per context:

| Context | Box | Logo budget | h-padding |
|---|---|---|---|
| Rotating flow card | 104 × 40 | 72 × 22 | 16px |
| Matrix integration card | 132 × 48 | 92 × 26 | 20px |

When `logoSrc` is null, falls back to a colored monogram tile (brand-hex bg, white letter, mono).

### Eyebrow pill

```html
<span className="inline-flex items-center gap-2 rounded-full px-3 py-1
                 font-mono text-[10px] uppercase tracking-[0.22em]"
      style="border: 1px solid rgba(255,255,255,0.08);
             background: rgba(255,255,255,0.02);
             color: rgba(240,240,240,0.62);">
  <span className="h-1 w-1 rounded-full" style="background: #5EEAD4" />
  Hub de Integrações
</span>
```

### Live dot (pulse)

Concentric two-layer dot: a static inner dot + an animated ring that scales 1 → 1.8 with fading opacity, 2s infinite. Powered by Framer Motion. Defined once in `LiveDot()`.

### Flow connector

1 pixel wide vertical line, 24px tall, painted with a repeating mint dotted gradient. CSS animation translates the background position downward for the data-flow effect.

```html
<div style="background-image: repeating-linear-gradient(180deg, #5EEAD4 0 2px, transparent 2px 8px);
            background-size: 1px 8px;
            animation: rk-flow-down 0.9s linear infinite;" />
```

### Code panel

Terminal-chrome treatment:

```
┌─────────────────────────────────┐
│ ● ● ●     activate.sh           │  ← header row, mono micro-label
├─────────────────────────────────┤
│ POST /api/integrations/activate │  ← first line in ACCENT cyan
│ { ...payload }                  │  ← body lines in #F0F0F0 @ 85%
│ 200 OK · webhooks registados    │  ← last line in ACCENT_HOT mint
└─────────────────────────────────┘
```

Background `rgba(0,0,0,0.5)`, monospace `12px / 1.6`, no syntax highlighter — just per-line color via index.

---

## 7. Iconography

- **Lucide** at **`strokeWidth: 1.5`** uniformly. Never 2.0 or 1.0 — visual rhythm depends on the consistent stroke.
- Sized `h-3` to `h-5` depending on context.
- **Banned**: Material Icons, FontAwesome, emoji, decorative SVGs that aren't icons.
- **Cliché icons banned**: rocket for "launch", shield for "security" — prefer Workflow, Layers, ScrollText.

---

## 8. Layout & spacing

- **Max content width**: `max-w-[1280px]` mx-auto, `px-4` gutter.
- **Section vertical rhythm**: `pt-32 md:pt-44` between major sections. Hero starts at `pt-14 md:pt-24`. Final section also pads bottom (`pb-24 md:pb-32`).
- **Grid breakpoints**: `md:` (768px) is the primary handoff. Below, everything collapses to single-column `w-full`.
- **Asymmetric editorial**: hero is 7/12 + 5/12 split. Section heads are 5/12 title + 6/12-from-col-7 sub. Step rows are 6/12 + 6/12 zig-zag.
- **Mobile rule**: every asymmetric `md:`-layout must collapse to single-column with full width and stacked vertical rhythm. `min-h-[100dvh]` (never `h-screen`) for full-viewport sections.

---

## 9. Forbidden patterns

| Don't | Why |
|---|---|
| `bg-slate-950` + `bg-purple-500/20` glow blobs | The exact AI slop the redesign replaced. |
| Generic 3-column equal-feature-card row | Most common AI-template signature. Use zig-zag, asymmetric, or specialized grids (matrix). |
| `h-screen` for full-height sections | iOS Safari viewport bug — `min-h-[100dvh]` instead. |
| Inter / Roboto / system-ui display | Locked to Geist. |
| Italic serif emphasis | Was the rejected cozy-editorial variant. |
| Pure white pill behind logos | Replaced by transparent logo on paper card. |
| Hardcoded `2.0` pill next to wordmark | The 2.0 is baked into the new SVG. Don't double up. |
| Multi-color accents | One brand cyan + one mint pop. Never two equal accents. |
| `Mono color={ACCENT_HOT}` in headlines | Use `<Gradient>` instead — headlines unified. Mono accents reserved for body / micro-labels. |

---

## 10. File map

| Concern | File |
|---|---|
| Landing root server shell (auth redirect) | `backoffice/src/app/page.tsx` |
| Font setup | `backoffice/src/app/fonts.ts` |
| Landing client component (all sections) | `backoffice/src/components/landing/Landing.tsx` |
| Brand SVGs | `backoffice/public/images/{rioko2-logo,rioko2-logo-black,shopify-logo,stripe-logo,easypay-logo,eupago-logo,ifthenpay-logo,invoicexpress-logo,moloni-logo,vendus-logo,logo-kapta-white}.{svg,webp}` |
| Favicon | `backoffice/src/app/icon.svg` + `backoffice/src/app/apple-icon.svg` |
| This guide | `docs/brand-guideline.md` |

---

## 11. Tokens at a glance (TS)

```ts
// Copy-paste header for new landing sections
const SURFACE     = "#0E1116";
const SURFACE_2   = "#14181F";
const PAPER       = "#EAEAE4";
const FG          = "#F0F0F0";
const FG_60       = "rgba(240,240,240,0.62)";
const FG_40       = "rgba(240,240,240,0.40)";
const INK         = "#14181F";
const INK_60      = "rgba(20,24,31,0.62)";
const INK_40      = "rgba(20,24,31,0.42)";
const RULE        = "rgba(255,255,255,0.08)";
const HAIRLINE    = "rgba(255,255,255,0.06)";
const PAPER_RULE  = "rgba(0,0,0,0.06)";
const ACCENT      = "#028DC4";
const ACCENT_HOT  = "#5EEAD4";
const SOON        = "#F59E0B";

const HEADLINE_GRADIENT =
  "linear-gradient(135deg, #06B6D4 0%, #028DC4 55%, #0369A1 100%)";

const EASE: [number, number, number, number] = [0.32, 0.72, 0, 1];
```
