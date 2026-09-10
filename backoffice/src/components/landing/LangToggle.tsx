"use client";

import * as React from "react";
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

  function switchTo(next: string) {
    if (next === locale) return;
    setPending(next);
    // usePathname() already resolves dynamic segments, so pass as-is
    router.replace(pathname as any, { locale: next });
  }

  return (
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
  );
}
