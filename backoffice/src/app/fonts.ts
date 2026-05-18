import { Instrument_Serif, Geist, Geist_Mono } from "next/font/google";

export const editorialSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-editorial",
  display: "swap",
});

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
