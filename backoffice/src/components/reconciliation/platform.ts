// Display labels for the reconciliation source (left) and destination (right)
// platforms. Keeps the conciliação UI dynamic instead of hardcoding
// "Shopify ↔ InvoiceXpress".
import { ShoppingBag, Home, CreditCard, Receipt, FileText, type LucideIcon } from "lucide-react";

const SOURCE_LABEL: Record<string, string> = {
    shopify: "Shopify",
    lodgify: "Lodgify",
    stripe: "Stripe",
    eupago: "EuPago",
};

const DEST_LABEL: Record<string, string> = {
    invoicexpress: "InvoiceXpress",
    moloni: "Moloni",
    vendus: "Vendus",
};

const SOURCE_ICON: Record<string, LucideIcon> = {
    shopify: ShoppingBag,
    lodgify: Home,
    stripe: CreditCard,
    eupago: Receipt,
};

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export const sourceLabel = (s?: string | null) => SOURCE_LABEL[s ?? ""] ?? (s ? cap(s) : "Origem");
export const destLabel = (d?: string | null) => DEST_LABEL[d ?? ""] ?? (d ? cap(d) : "Faturação");
export const sourceIcon = (s?: string | null): LucideIcon => SOURCE_ICON[s ?? ""] ?? ShoppingBag;
export const destIcon = (_d?: string | null): LucideIcon => FileText;

/** The left-side "record" noun per source: Shopify has encomendas, Lodgify has
 *  reservas. Used in copy ("Sem fatura", pending messages, search placeholder). */
export const recordNoun = (s?: string | null): { singular: string; plural: string } =>
    s === "lodgify" ? { singular: "reserva", plural: "reservas" } : { singular: "encomenda", plural: "encomendas" };
