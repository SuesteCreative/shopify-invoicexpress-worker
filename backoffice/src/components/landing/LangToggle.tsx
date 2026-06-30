"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";

type Props = {
  variant?: "dark" | "light";
};

export function LangToggle({ variant = "dark" }: Props) {
  const t = useTranslations("lang");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  function switchTo(next: string) {
    if (next === locale) return;
    // usePathname() already resolves dynamic segments, so pass as-is
    router.replace(pathname as any, { locale: next });
  }

  const isDark = variant === "dark";
  const bg = isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)";
  const border = isDark
    ? "1px solid rgba(255,255,255,0.10)"
    : "1px solid rgba(0,0,0,0.10)";
  const activeBg = isDark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.12)";
  const activeFg = isDark ? "#F0F0F0" : "#14181F";
  const inactiveFg = isDark ? "rgba(240,240,240,0.55)" : "rgba(20,24,31,0.55)";

  return (
    <div
      role="group"
      aria-label={t("switchTo")}
      className="inline-flex items-center gap-0.5 rounded-full p-0.5"
      style={{ background: bg, border }}
    >
      {routing.locales.map((l) => {
        const active = l === locale;
        return (
          <button
            key={l}
            type="button"
            onClick={() => switchTo(l)}
            aria-pressed={active}
            className="font-mono text-[10px] uppercase tracking-[0.18em] rounded-full px-2.5 py-1 transition-colors duration-300"
            style={{
              background: active ? activeBg : "transparent",
              color: active ? activeFg : inactiveFg,
              cursor: active ? "default" : "pointer",
            }}
          >
            {t(l as "pt" | "en")}
          </button>
        );
      })}
    </div>
  );
}
