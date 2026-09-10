# Day Mode — handover

**Branch:** `feat/day-mode` (cut from `feat/stripe-connect-clean`)
**State:** working tree only. **Nothing is committed, nothing is deployed.** That is deliberate.
**Author of this pass:** Claude Opus 5, 09–10/09/2026, at Pedro's request.

The ask was: keep the existing dark chrome, call it **Night Mode**, add a **Day Mode** modelled on
<https://admin.kapta.pt/dashboard>, put a toggle beside the language toggle, and make Day the
default once it is finished. Cosmetics only. No behaviour may change.

---

## 1. What to do with this branch

1. Read section 6 (**Known gaps**) first, it is the honest list of what is not finished.
2. Get the app running locally — see section 5, it needs Clerk keys that are not in the repo.
3. Walk the pages in both skins, fix what section 6 lists.
4. Then commit and open a PR. Do **not** merge to `main` casually: `main` auto-deploys to the
   `rioko` Cloudflare Pages project, so a merge is a production release.

There is deliberately no commit yet, so you can rebase, split or squash this however you like.

---

## 2. How the theming works

One attribute on `<html>` drives everything:

```html
<html data-theme="day">   <!-- or "night" -->
```

Every colour in the app resolves through a CSS variable, and both skins are just two blocks of
variable values in [`src/app/globals.css`](src/app/globals.css). Switching the attribute repaints
the UI; no component re-renders, no request, no server involvement.

### The pieces

| File | Role |
| --- | --- |
| `src/app/globals.css` | Both palettes, the `@theme inline` mapping to Tailwind utilities, and the `.glass` / `.brand-ambient` / `.seg` recipes. **The single source of truth.** |
| `src/lib/theme.ts` | `THEMES`, `DEFAULT_THEME`, `THEME_STORAGE_KEY`, and `THEME_BOOTSTRAP_SCRIPT`. |
| `src/components/ThemeToggle.tsx` | The pill. Writes `localStorage` and flips the attribute. |
| `src/components/landing/LangToggle.tsx` | Rewritten to paint from tokens instead of a `variant` prop. |
| `src/app/[locale]/layout.tsx` | Runs the bootstrap script in `<head>`; `suppressHydrationWarning` on `<html>`. |
| `src/messages/{pt,en}.json` | New `theme` namespace: `switchTo`, `day`, `night`. |

### Persistence

`localStorage["rioko-theme"]`, per browser. No cookie, no database column, no API call — so the
theme can never reach the server and can never influence what the app does. It does mean the choice
does not follow a user between devices; if that is wanted later it becomes a real (functional)
change and should be decided separately.

The key does not collide with the other three the app uses (`rioko-consent`,
`rioko_attr_synced`, `rioko_setup_modal_dismissed:`).

### No flash of the wrong palette

`THEME_BOOTSTRAP_SCRIPT` is inlined into `<head>` and runs before the first paint. It was tested
against a stored `day`, a stored `night`, no value, a garbage value, and a `localStorage` that
throws (private windows, blocked site data): every case resolves to a valid theme, defaulting to
`day`.

The toggle also sets `data-theme-switching` on `<html>` for two animation frames, which suppresses
every CSS transition, so the repaint is a clean cut rather than a few hundred elements each easing
to a new colour at their own pace.

### The default

`DEFAULT_THEME` in `src/lib/theme.ts` is `"day"`, as asked. Flip that one constant to `"night"` if
you want to ship the toggle before the Day pass is finished.

---

## 3. The tokens

Night keeps the original Rioko values exactly. Day is the Kapta admin palette, read off
<https://admin.kapta.pt/dashboard> (its compiled CSS, not guessed from a screenshot).

| Tailwind utility | Variable | Night | Day |
| --- | --- | --- | --- |
| `bg-surface`, `text-surface` | `--background` | `#0E1116` | `#F6F3EE` cream |
| `text-fg`, `bg-fg` | `--foreground` | `#F0F0F0` | `#111111` ink |
| `bg-surface-2` | `--surface-2` | `#14181F` | `#FFFFFF` card |
| `text-fg-60` | `--fg-60` | white 62% | `#4B4B4B` ink-mid |
| `text-fg-40` | `--fg-40` | white 40% | `#8A857E` ink-muted |
| `border-hairline` | `--hairline` | white 6% | `#E7DED3` |
| `border-rule` | `--rule` | white 8% | `#E7DED3` |
| `border-hairline-strong` | `--hairline-strong` | white 14% | `#CABFB2` |
| `bg-accent`, `border-accent` | `--accent` | `#028DC4` | `#C75C4A` terracotta |
| `text-accent` | `--accent-ink` | `#028DC4` | `#8E3625` |
| `*-accent-hot` (success) | `--accent-hot` | `#5EEAD4` | `#065F46` |
| `*-soon` (warning) | `--soon` | `#F59E0B` | `#92400E` |
| `*-destructive` (error) | `--destructive` | `#F43F5E` | `#B42318` |
| `text-on-accent` | `--on-accent` | `#F0F0F0` | `#FFFFFF` |
| `bg-veil` | `--veil` | white 5% | ink 4% |
| `bg-veil-strong` | `--veil-strong` | white 10% | ink 8% |
| `ring-sunken` | `--sunken` | black 20% | ink 10% |
| `bg-track-off` | `--track-off` | `#14181F` | `#CABFB2` |
| `bg-scrim` | `--scrim` | black 60% | ink 40% |
| `text-accent-hover` | `--accent-hover` | `#3AA9D8` | `#C75C4A` |
| `bg-media-plate` | `--media-plate` | `#FFFFFF` | `#FFFFFF` |
| `text-on-media` | `--on-media` | `#111111` | `#111111` |

And four declared **only** in the day block, so night keeps whatever literal the call site
passes as the `var()` fallback: `--paper`, `--paper-edge`, `--paper-hover`, `--live-ink`, plus
the five `--pill-*` provider inks. The headline gradient runs on `--headline-1/2/3`, which are
declared in both.

Plus, for inline styles and CSS: `--glass-bg`, `--glass-border`, `--glass-inset`, `--glass-shadow`,
`--glass-blur`, `--shadow-card`, `--shadow-lift`, `--ambient-1`, `--ambient-2`, `--logo-invert`,
`--logo-dim`.

Opacity modifiers follow the theme automatically, because Tailwind v4 compiles `bg-accent-hot/10`
to `color-mix(in oklab, var(--accent-hot) 10%, transparent)`.

### Two decisions worth knowing about

**`--accent` is split in two.** `#C75C4A` is Kapta's terracotta and it is what fills plates and
draws rules, exactly as asked. But terracotta type on cream only reaches about 3:1, so
`text-accent` resolves to a deeper `#8E3625` in day mode, through one unlayered rule at the bottom
of `globals.css`. Kapta does the same thing in their own CSS (they ship `accent` and `accent-text`
as separate colours). If you ever need the literal brand terracotta as type, use
`style={{ color: "var(--accent)" }}`.

**Status colours are the dark end of each ramp in day mode.** `#065F46` / `#92400E` / `#B42318`
rather than the brighter mid-tones, so that a 10% tint plate still carries readable text. Same
choice Kapta made (emerald-800 / amber-800 / red-700).

### What was NOT copied from Kapta

- **Layout.** Kapta uses a horizontal top nav; Rioko keeps its left sidebar. Chosen deliberately
  (moving the nav is a structural change, not an aesthetic one).
- **Fonts.** Kapta uses General Sans and Satoshi. Rioko keeps Geist, self-hosted via `next/font`.
  Worth knowing: `admin.kapta.pt` does not actually load those two fonts, it just names them, so it
  only renders as intended on a machine where they happen to be installed.

---

## 4. What was changed, and how

Three passes, in order.

### Pass 1 — the token layer (by hand)

`globals.css` rewritten into `:root,[data-theme="night"]` + `[data-theme="day"]`, with the extra
tokens above. `.glass`, `.brand-ambient` and `.glass-card.complete` now read from variables instead
of hardcoded rgba, so they follow the theme. Added `.seg` (shared by both toggles), `.logo-adaptive`
and the `[data-theme-switching]` transition kill-switch.

### Pass 2 — mechanical codemods (scripted, deterministic)

Two scripted find-and-replace passes over `src/**/*.tsx`. Both were written so the **night**
rendering is unchanged: every substitution resolves to the same pixels it did before.

| Pass | What | Count |
| --- | --- | --- |
| Brand rgba literals | `bg-[rgba(94,234,212,0.10)]` → `bg-accent-hot/10`, and the same for the cyan, amber and rose literals. Shadows and gradients that could not take an opacity modifier became `color-mix(in_srgb,var(--token)_N%,transparent)`. | 801 across 38 files |
| Literal white/black | `bg-white text-black` → `bg-fg text-surface`; `text-white` on a filled plate → `text-on-accent`; other `text-white` → `text-fg`; `bg-white/5` → `bg-veil`; `bg-white/10` → `bg-veil-strong`; `border-white/5` → `border-veil`; `ring-black/20` → `ring-sunken`. | 224 |

### Pass 3 — per-file conversion (agent fan-out, adversarially reviewed)

Everything left needed judgement: the two landing pages keep their colours in module-level style
constants rather than Tailwind classes, and a long tail of pages still used the raw Tailwind palette
(`bg-slate-950`, `text-amber-300`, `text-emerald-400`, …). Eight groups of files were converted and
then each was re-checked by a second pass whose only job was to find behaviour changes, night
regressions, day-illegible pairings and missed literals.

Results are in section 7.

### The toggle

`<ThemeToggle />` sits next to `<LangToggle />` at all eight places the language pill appears:
the sidebar (stacked above it, because the drawer is only 280px wide), the landing header and its
mobile menu, the `/shopify` landing header, sign-in, sign-up, privacy, terms and the 404.

Both pills share one CSS grammar (`.seg`). The active segment of the theme pill is chosen by CSS
from the `data-theme` attribute rather than from React state, so it is already correct on the first
paint and there is nothing for hydration to disagree about.

---

## 5. Running it locally

**The dev server will not render any page as things stand.** `backoffice/.env.local` has no Clerk
keys, and `src/middleware.ts` wraps every route in `clerkMiddleware()`, so every request 500s with
`@clerk/clerk-react: Missing publishableKey`. That is pre-existing and unrelated to this branch.

To work on Day Mode you need to add to `backoffice/.env.local`:

```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=...
CLERK_SECRET_KEY=...
```

Then:

```bash
npm run dev --prefix backoffice
```

`.claude/launch.json` was added so the browser tooling can start that server by name. It is a dev
convenience, not app code. Drop it from the commit if you would rather not track it.

### Checking the theme without Clerk

Colour work can be verified without the app running, by compiling the real Tailwind output against
the real source and rendering the component vocabulary in both skins side by side. That is how this
pass was checked. To rebuild it:

```bash
cd backoffice && { echo '@source "./src";'; echo '@source "./public/themelab";'; cat src/app/globals.css; } > .lab.css && npx @tailwindcss/cli -i .lab.css -o public/themelab/lab.out.css && rm .lab.css
```

with a `public/themelab/lab.html` that renders the same markup twice, once inside
`<div data-theme="night">` and once inside `<div data-theme="day">`. Serve it at
`http://localhost:3000/themelab/lab.html` — the middleware matcher excludes `.html` and `.css`, so
it loads without Clerk. The lab is **not** in the repo, on purpose: it is scaffolding, not app
code. Recreate it when you need it and delete `public/themelab/` again before committing.

The useful measurement is not a screenshot but a contrast diff: compute the effective foreground and
background of every element in both panes and report only the cases where **day is worse than
night**. Night is the baseline that already ships, so anything equally faint in both is existing
design language rather than a regression introduced here.

---

## 6. Known gaps

Nothing here blocks looking at the branch. These are the honest edges.

### Cannot be verified locally yet

**No page has been rendered by Next.** `backoffice/.env.local` carries no Clerk keys and
`clerkMiddleware()` wraps every route, so the dev server 500s on everything (section 5). Everything
below was verified by compiling the real Tailwind output against the real source and measuring it,
not by walking the app. Someone with Clerk keys should walk both skins through: dashboard, each
integration wizard, faturação, conciliação, invoices, superadmin, dev-mode, help, the two landings,
sign-in, sign-up, blog, privacy, terms, and the mobile drawer.

**Clerk's own widgets are unthemed.** `<SignIn>`, `<SignUp>` and `<UserButton>` paint themselves
with Clerk's default light appearance. That already suits day mode; at night they are a light card
on a dark page, which is how they render today too. No `appearance` prop was added, deliberately.

### Left as they are, on purpose

- **98 colour literals remain**, none of them a Tailwind palette utility. They break down as
  38 `bg-white` switch knobs and `bg-black/NN` modal scrims (correct in both skins), about 50
  `rgba()` pure-black drop shadows and white inset sheens on saturated plates (also correct in
  both), and 10 hex values living on the landings' light "paper" island. Tokenising these would
  move night pixels for no day-mode gain.
- **The `text-fg-40` micro-labels sit at 3.3–3.4:1 on cream**, under the 4.5:1 AA line for small
  text. That is not a Day Mode regression: night measures 3.5:1 for the same labels, and `#8A857E`
  is Kapta's own `ink-muted`, used for exactly these eyebrow labels on `admin.kapta.pt`. Raising it
  would depart from the reference. Worth a separate accessibility decision, taken for both skins at
  once.
- **`INK` / `INK_60` / `INK_40`** stay literal in `src/lib/brand-tokens.ts` and in both landings.
  They are dark type on the paper island, which is light in *both* skins, so a token would be wrong.

### Worth a second look

- **The `/shopify` landing has an art direction of its own** ("Midnight Ledger": a dark page with a
  printed-document island). It now follows the theme, but it was composed for a dark ground. If it
  reads badly by day, pinning that one page to night is a one-line change: put `data-theme="night"`
  on its root element.
- **`prose-rioko`** is applied to the blog article body at `blog/[slug]/page.tsx:114` and is defined
  nowhere in the repo. Pre-existing and unrelated to this work, but it means article bodies are
  unstyled in both skins.
- **`<ThemedLogo>` renders both artwork files** and lets CSS pick. The hidden one still downloads.
  For two small SVG/WebP marks that is a fair trade for being correct on the first paint with no
  client state, but it is a choice, not a law.

---

## 7. Results of the per-file pass

Eight groups, 49 files, converted and then re-checked by a second pass whose only job was to
disbelieve the first. 16 agents, none errored.

| Group | Files | Converted | Behaviour flags | Literals left |
| --- | ---: | ---: | ---: | ---: |
| landing | 1 | 67 | 1 | 29 |
| shopify-landing | 1 | 30 | 1 | 23 |
| chrome | 9 | 50 | 1 | 12 |
| reconciliation | 3 | 7 | 0 | 0 |
| public-pages | 5 | 31 | 1 | 0 |
| admin | 2 | 18 | 0 | 15 |
| integrations-a | 6 | 52 | 0 | 18 |
| integrations-b | 10 | 48 | 0 | 17 |

**All four behaviour flags were the ThemeToggle wiring** — the new import, the `<ThemeToggle />`
element, and `<LangToggle>` losing its now-ignored `variant` prop. That is this task, correctly
detected and correctly not reverted. No other non-cosmetic change was found in any group: no props,
handlers, conditions, i18n keys, element order, aria attributes or copy moved, and both branches of
every colour ternary were converted with the condition left alone.

### What the review caught that the conversion missed

Six real defects, all since fixed.

1. **`text-accent` had 25 variants the day override never matched.** The first design deepened the
   accent-as-type through a single CSS rule on `.text-accent`. Tailwind emits `hover:text-accent` as
   `.hover\:text-accent:hover`, which that selector does not match, so 14 `hover:`, 9
   `group-focus-within:` and 2 `group-hover/lbl:` sites would have shipped as raw terracotta at
   roughly 3:1. Fixed properly: `text-accent` is now `text-accent-ink`, a real token, renamed at all
   199 sites. Night is byte-identical, because `--accent-ink` *is* `--accent` at night. The fragile
   override rule is gone.

2. **`logo-adaptive` was applied to marks that are not monochrome.** `rioko2-logo.svg` carries
   `#fff`, `#f2f2f2`, brand cyan `#028dc4` and two black drop shadows, so `invert(1)` turns the cyan
   orange and the shadows into white halos. `logo-kapta-white.webp` carries the brand red `#E12726`,
   which inverts to cyan. Both now use `<ThemedLogo>` with a real ink twin.
   `rioko2-logo-black.svg` already existed; `logo-kapta-black.webp` was generated from the white one
   by moving only the near-white wordmark pixels to `#111111`, leaving the red dot and every alpha
   value untouched. The invert is kept for `lodgify-logo-white.svg`, which really is a single `#fff`.
   Every other provider mark was measured: all carry mid or dark brand colours and read on cream.

3. **A logo plate was converted as if it were a button.** `bg-white text-black` became
   `bg-fg text-surface` in 72 places. 71 are genuine inverted CTAs; one
   (`integrations/page.tsx:394`) is the plate the EuPago and Lodgify marks sit on, and by day it
   would have turned to ink with near-black artwork on it. That one now uses `bg-media-plate` /
   `text-on-media`, a pair that is white and ink in *both* skins by design.

4. **The headline gradient stayed cyan.** Three literal cyan stops drove every `<Gradient>` span:
   the landing h1, every section head, the final CTA. Now three tokens: cyan at night, a terracotta
   run by day.

5. **The "printed paper" islands vanished into the cream page.** `#F4F1EA` against a `#F6F3EE`
   ground is a 1.02:1 difference. Solved without touching night: `--paper` and `--paper-edge` are
   declared *only* in the day block, and each page passes its own night literal as the `var()`
   fallback, so night keeps its exact value while day gets a white card with the Kapta hairline.
   The same trick carries `--live-ink`, `--paper-hover` and the provider pills.

6. **Provider pills in `/superadmin` were pastel on cream.** Measured: Shopify 1.54:1, Stripe
   1.98:1, InvoiceXpress 1.29:1, Moloni 1.97:1, Vendus 2.03:1. Each keeps its brand hue but takes a
   dark enough value by day: now 6.49, 5.32, 7.73, 5.20 and 6.05.

Two gaps the grouping itself left, found afterwards and fixed: `src/lib/brand-tokens.ts` (raw hex
constants, owned by no group, imported by `components/brand`) and `ConsentBanner`'s
`hover:text-[#3aa9d8]`, which by day would have flipped a deep terracotta link to pale cyan at about
2.3:1. That hover now uses `--accent-hover`, which lifts to the brighter cyan at night and to the
full brand terracotta by day.

### Measurements

Contrast was computed rather than eyeballed: each element's effective foreground and background were
composited through the whole ancestor chain, in both skins, and only cases where **day is worse than
night** counted as regressions. Night is the baseline that already ships, so anything equally faint
in both is existing design language.

| Run | Regressions | Elements checked |
| --- | ---: | ---: |
| First pass over the token layer | 12 | 74 |
| After the token fixes | 0 | 74 |
| Final, with pills, paper island, gradient and link hover added | **0** | **87** |

`npm run build --prefix backoffice` passes (exit 0). It was re-run after every stage.

### Totals

| Stage | Replacements |
| --- | ---: |
| Codemod 1, brand `rgba()` literals | 801 |
| Codemod 2, literal white and black | 224 |
| Agent pass, 8 groups | 303 |
| `text-accent` to `text-accent-ink` | 199 |
| Targeted fixes after review | ~30 |
| **Total** | **~1,557** |

Colour literals left in `src`: **98**, none of them a Tailwind palette utility.

---

## 8. Files touched

New:

```
backoffice/src/lib/theme.ts                    themes, default, storage key, bootstrap script
backoffice/src/components/ThemeToggle.tsx      the pill
backoffice/src/components/ThemedLogo.tsx       two-file artwork pair
backoffice/public/images/logo-kapta-black.webp derived ink Kapta mark
backoffice/DAY-MODE.md                         this file
.claude/launch.json                            dev-server config for the browser tooling
```

Rewritten:

```
backoffice/src/app/globals.css                 both palettes and every recipe
backoffice/src/lib/brand-tokens.ts             hex constants to var()
backoffice/src/components/landing/LangToggle.tsx  paints from tokens, ignores `variant`
```

Everything else is a colour-value edit across 51 files, plus the `<ThemeToggle />` insertion at the
eight places `<LangToggle>` appears and the theme bootstrap in `app/[locale]/layout.tsx`.
