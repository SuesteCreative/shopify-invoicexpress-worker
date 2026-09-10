/**
 * Rioko has two skins. `night` is the original chrome; `day` replicates the
 * Kapta admin's cream/ink editorial look. The choice is cosmetic and lives in
 * the browser only — no cookie, no request header, no database column — so a
 * theme can never change what the app does or what it renders on the server.
 */
export const THEMES = ["day", "night"] as const;
export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = "day";
export const THEME_STORAGE_KEY = "rioko-theme";

/** The skin this browser picked, or the default. Never throws: a private
 *  window or blocked site data simply gets the default back. */
export function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "day" || stored === "night") return stored;
  } catch {
    // Site data blocked — the default is the honest answer.
  }
  return DEFAULT_THEME;
}

/**
 * Runs in <head>, before the first paint, so the page never shows one palette
 * and then swaps to the other. Kept dependency-free and wrapped in try/catch:
 * a browser with site data blocked still renders, it just renders the default.
 */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t!=="day"&&t!=="night"){t=${JSON.stringify(
  DEFAULT_THEME,
)};}document.documentElement.setAttribute("data-theme",t);}catch(e){document.documentElement.setAttribute("data-theme",${JSON.stringify(
  DEFAULT_THEME,
)});}})();`;
