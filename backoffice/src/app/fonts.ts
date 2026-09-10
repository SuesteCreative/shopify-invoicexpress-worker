import { Geist, Geist_Mono } from "next/font/google";
import localFont from "next/font/local";

export const sansDisplay = Geist({
  subsets: ["latin"],
  variable: "--font-sans-display",
  display: "swap",
});

export const monoFont = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

/**
 * The Kapta admin's two faces, self-hosted. Day Mode uses them; Night keeps
 * Geist. Which of the two a given element gets is decided in globals.css by
 * `--font-sans` and `--font-display`, so neither skin ever names a file.
 *
 * Sources live in `src/fonts/`, converted from the OTF originals to woff2
 * (roughly half the bytes, and the only format any target browser needs).
 */
export const generalSans = localFont({
  variable: "--font-general-sans",
  display: "swap",
  src: [
    { path: "../fonts/general-sans/GeneralSans-Regular.woff2", weight: "400", style: "normal" },
    { path: "../fonts/general-sans/GeneralSans-Italic.woff2", weight: "400", style: "italic" },
    { path: "../fonts/general-sans/GeneralSans-Medium.woff2", weight: "500", style: "normal" },
    { path: "../fonts/general-sans/GeneralSans-Semibold.woff2", weight: "600", style: "normal" },
    { path: "../fonts/general-sans/GeneralSans-Bold.woff2", weight: "700", style: "normal" },
  ],
});

export const satoshi = localFont({
  variable: "--font-satoshi",
  display: "swap",
  src: [
    { path: "../fonts/satoshi/Satoshi-Regular.woff2", weight: "400", style: "normal" },
    { path: "../fonts/satoshi/Satoshi-Medium.woff2", weight: "500", style: "normal" },
    { path: "../fonts/satoshi/Satoshi-Bold.woff2", weight: "700", style: "normal" },
    { path: "../fonts/satoshi/Satoshi-Black.woff2", weight: "900", style: "normal" },
  ],
});
