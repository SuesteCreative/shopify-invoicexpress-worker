"use client";

import * as React from "react";
import { useAuth } from "@clerk/nextjs";
import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";

type Props = {
  /**
   * Kept so existing call sites keep compiling. The pill now paints itself from
   * the active theme's variables, so it is legible on either skin without the
   * caller having to know which one is on.
   */
  variant?: "dark" | "light";
};

export function LangToggle(_props: Props = {}) {
  const t = useTranslations("lang");
  const { isSignedIn } = useAuth();
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  // The locale only changes once the server has answered, and the pages are
  // force-dynamic, so the pill would sit unchanged for a beat after a click.
  // Showing the pending choice straight away stops that pause reading as
  // "nothing happened", and stops the real move from landing later, next to
  // whatever the user pressed in the meantime.
  const [pending, setPending] = React.useState<string | null>(null);
  React.useEffect(() => setPending(null), [locale]);
  const shown = pending ?? locale;

  /** Set when the server took the click but wrote nothing — see switchTo. */
  const [note, setNote] = React.useState(false);

  async function switchTo(next: string) {
    if (next === locale) return;
    setPending(next);

    // For someone signed in, the pill is not a per-tab preference: it is the
    // language their account is written to, emails included. It has to be
    // recorded BEFORE the move, because the signed-in surface sends every page
    // to the language on record — navigating first would be sent straight back.
    // A visitor with no account has nothing to record and never waits for this.
    if (isSignedIn) {
      const saved = await fetch("/api/user/language", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language: next }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null) as { persisted?: boolean } | null;

      // The route refuses to write while an operator is impersonating, so that
      // reading a client's panel in your own language cannot rewrite theirs.
      // That refusal has to be visible: a deliberate click that changes only
      // this screen, and says nothing, reads as a setting that was saved.
      setNote(saved?.persisted === false);
    }

    // usePathname() already resolves dynamic segments, so pass as-is
    router.replace(pathname as any, { locale: next });
  }

  return (
    <>
    <div
      role="group"
      aria-label={t("switchTo")}
      className="inline-flex items-center gap-0.5 rounded-full p-0.5 border border-hairline bg-veil"
    >
      {routing.locales.map((l) => {
        const active = l === shown;
        return (
          <button
            key={l}
            type="button"
            onClick={() => switchTo(l)}
            aria-pressed={active}
            className="seg font-mono text-[10px] uppercase tracking-[0.18em] rounded-full px-2.5 py-1 transition-colors duration-300"
          >
            {t(l as "pt" | "en")}
          </button>
        );
      })}
    </div>
    {/* Only ever seen by an operator inside someone else's account: the screen
        moved, the client's record did not. A fragment rather than a wrapper, so
        the pill keeps the box every caller already lays out around it. */}
    {note && (
      <span role="status" className="text-[10px] font-medium text-fg-40 max-w-[240px] leading-snug">
        {t("notSavedImpersonating")}
      </span>
    )}
    </>
  );
}
