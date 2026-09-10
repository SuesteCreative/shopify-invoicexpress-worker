"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Moon, Sun } from "lucide-react";
import { readStoredTheme, THEMES, THEME_STORAGE_KEY, type Theme } from "@/lib/theme";

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

  // Switching language navigates across the [locale] segment, which re-renders
  // <html> from the server. The server never sends `data-theme` — only the
  // bootstrap script writes it, and that runs on a full page load — so Next
  // drops the attribute on the way through, the page falls back to night, and
  // the language toggle looks like it changed the skin.
  //
  // Watching the attribute is what makes the two toggles independent: whatever
  // removes it, it goes straight back to the stored choice, and the pill is
  // driven by what is actually painted rather than by a one-off read at mount.
  React.useEffect(() => {
    const root = document.documentElement;

    function sync() {
      const current = root.getAttribute("data-theme");
      if (current === "day" || current === "night") {
        setTheme(current);
        return;
      }
      // Missing or garbage: put the stored choice back. Setting it re-enters
      // this callback once with a valid value, which takes the branch above,
      // so there is no loop.
      const wanted = readStoredTheme();
      root.setAttribute("data-theme", wanted);
      setTheme(wanted);
    }

    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  function switchTo(next: Theme) {
    const root = document.documentElement;
    if (root.getAttribute("data-theme") === next) return;

    // Stored before the attribute is touched: that is what the watcher above
    // reads, so if anything strips `data-theme` right after this it comes back
    // as the choice just made and not as the default.
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Site data blocked — the theme still applies, it just won't be remembered.
    }

    // Suppress every transition for one frame, so the repaint is a cut and not
    // a few hundred elements each easing to a new colour at their own pace.
    root.setAttribute("data-theme-switching", "");
    root.setAttribute("data-theme", next);
    setTheme(next);

    // Tell the server, so the emails we send this account are dressed the same
    // way. Deliberately not awaited and deliberately silent: the page never
    // waits on it, and a signed-out visitor simply gets a 401 nobody reads.
    // What is on screen is still decided entirely by localStorage.
    void fetch("/api/user/theme", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: next }),
      keepalive: true,
    }).catch(() => { });
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
