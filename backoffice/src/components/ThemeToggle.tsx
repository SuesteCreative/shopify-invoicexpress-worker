"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Moon, Sun } from "lucide-react";
import { THEMES, THEME_STORAGE_KEY, type Theme } from "@/lib/theme";

/**
 * Sibling of <LangToggle>: same pill, same mono caps, same rhythm — this one
 * switches the skin instead of the language. Purely cosmetic: it writes a
 * localStorage key and flips `data-theme` on <html>, nothing else.
 *
 * The active segment is styled from CSS (`[data-theme="…"] .theme-seg[…]`)
 * rather than from React state, so it is already correct on the very first
 * paint and there is nothing for hydration to disagree about.
 */
export function ThemeToggle() {
  const t = useTranslations("theme");
  const [theme, setTheme] = React.useState<Theme | null>(null);

  React.useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    setTheme(current === "night" ? "night" : "day");
  }, []);

  function switchTo(next: Theme) {
    const root = document.documentElement;
    if (root.getAttribute("data-theme") === next) return;

    // Suppress every transition for one frame, so the repaint is a cut and not
    // a few hundred elements each easing to a new colour at their own pace.
    root.setAttribute("data-theme-switching", "");
    root.setAttribute("data-theme", next);
    setTheme(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Site data blocked — the theme still applies, it just won't be remembered.
    }
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => root.removeAttribute("data-theme-switching"));
    });
  }

  return (
    <div
      role="group"
      aria-label={t("switchTo")}
      className="inline-flex items-center gap-0.5 rounded-full p-0.5 border border-hairline bg-veil"
    >
      {THEMES.map((option) => {
        const Icon = option === "day" ? Sun : Moon;
        return (
          <button
            key={option}
            type="button"
            onClick={() => switchTo(option)}
            aria-pressed={theme === option}
            data-theme-option={option}
            title={t(option)}
            className="seg theme-seg font-mono text-[10px] uppercase tracking-[0.18em] rounded-full px-2.5 py-1 inline-flex items-center gap-1.5 transition-colors duration-300"
          >
            <Icon className="w-3 h-3" aria-hidden="true" />
            {t(option)}
          </button>
        );
      })}
    </div>
  );
}
