# Translations

App is bilingual: PT (default) + EN, with URL prefix routing (`/pt/...`, `/en/...`).

## Rule

**Every new user-facing string must land in both `pt.json` and `en.json`** before being merged. No hardcoded copy in components — read everything through `useTranslations()` (client) or `getTranslations()` (server).

## Stack

- `next-intl` ^4.x
- Routing config: `src/i18n/routing.ts`
- Server request config: `src/i18n/request.ts`
- Locale-aware `<Link>`, `redirect`, `usePathname`, `useRouter`: `src/i18n/navigation.ts`
- Middleware (Clerk + intl composition): `src/middleware.ts`
- Lang toggle: `src/components/landing/LangToggle.tsx`

## Adding a string

1. Pick a namespace key path (e.g. `dashboard.invoices.empty`).
2. Add the PT value in `src/messages/pt.json`.
3. Add the matching EN value in `src/messages/en.json` (same key path).
4. In the component:
   - Client: `const t = useTranslations("dashboard.invoices"); t("empty")`.
   - Server: `const t = await getTranslations({ locale, namespace: "dashboard.invoices" }); t("empty")`.
5. For rich content (JSX inside a string), use `t.rich("key", { g: c => <Gradient>{c}</Gradient>, br: () => <br/>, ... })`.

## Internal navigation

Always import `Link`, `redirect`, `useRouter`, `usePathname` from `@/i18n/navigation`, **never** from `next/link`/`next/navigation` — otherwise the locale prefix is lost.

External URLs (mailto, https://...) keep using a plain `<a>`.

## Clerk strings

`<ClerkProvider localization={…}>` in `app/[locale]/layout.tsx` swaps between `ptPT`/`enUS` automatically. Per-page Clerk components (`<SignIn>`, `<SignUp>`) receive explicit `path`/`signInUrl`/`signUpUrl`/`forceRedirectUrl` so their internal navigation stays inside the active locale.

## Scope status

- **Done (stage 1)**: landing, sign-in, sign-up, privacy, terms, 404.
- **Pending (stage 2)**: dashboard pages (`app/[locale]/(dashboard)/**`) and shared components (`NavLinks`, `RegistrationForm`, `IntegrationSetupModal`, `ImpersonationBanner`). They still render PT strings under both locales until migrated.

When migrating a dashboard page: replace each hardcoded literal with a translation key, add it to both JSON files, and swap any `import Link from "next/link"` to `import { Link } from "@/i18n/navigation"`.
