import { Bricolage_Grotesque, IBM_Plex_Mono } from "next/font/google";

// Page-scoped fonts for the /shopify landing ("Midnight Ledger" design).
// Deliberately separate from the global Geist pair in app/fonts.ts — this
// page carries its own visual identity.
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
