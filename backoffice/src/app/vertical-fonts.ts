import { Bricolage_Grotesque, IBM_Plex_Mono } from "next/font/google";

// Fonts for the vertical landings (/shopify, /lodgify, /stripe) — the
// "Midnight Ledger" design. Deliberately separate from the global Geist pair
// in app/fonts.ts: these pages carry their own visual identity, and next/font
// has to be called at module scope, so they live in one module all three share.
export const ledgerDisplay = Bricolage_Grotesque({
    subsets: ["latin"],
    variable: "--font-ledger-display",
    weight: ["500", "600", "700"],
    display: "swap",
});

export const ledgerMono = IBM_Plex_Mono({
    subsets: ["latin"],
    variable: "--font-ledger-mono",
    weight: ["400", "500", "600"],
    display: "swap",
});
