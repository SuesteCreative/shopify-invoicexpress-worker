import { Geist, Geist_Mono } from "next/font/google";

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
