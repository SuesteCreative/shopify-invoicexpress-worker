"use client";

import { FileText } from "lucide-react";
import { useTranslations } from "next-intl";
import { MAX_CUSTOM_INVOICE_NOTE } from "@/lib/connection-fiscal";

/**
 * The merchant's own line on their documents.
 *
 * It goes into the same field as the mandatory fiscal mentions, which is why it
 * is written last and why the limit is not negotiable: when the text does not
 * all fit, a truncated legal mention is a defective document and a truncated
 * merchant note is a cosmetic loss. The wizards show the limit for that reason,
 * not to be tidy.
 *
 * One component for every wizard that owns an InvoiceXpress or Moloni
 * connection, like `TaxRegistrations` beside it and for the same reason: copy
 * that states a fiscal consequence must not exist in eight versions. No
 * `destination` prop, because after the note reached Moloni's `notes` there is
 * nothing left that differs between the two.
 */

interface Props {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export default function InvoiceNote({ value, onChange, disabled }: Props) {
  const t = useTranslations("invoiceNote");
  const used = value.length;

  return (
    <div className="md:col-span-2 glass p-5 sm:p-8 rounded-[2rem] border-hairline space-y-4">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-soon/10 rounded-xl"><FileText className="w-4 h-4 text-soon" /></div>
        <div>
          <h3 className="font-bold text-sm tracking-tight">{t("title")}</h3>
          <p className="text-[10px] text-fg-40 font-medium uppercase tracking-wider mt-0.5">{t("subtitle")}</p>
        </div>
      </div>

      <p className="text-[11px] text-fg-60 leading-relaxed">{t("help")}</p>

      <textarea
        value={value}
        disabled={disabled}
        maxLength={MAX_CUSTOM_INVOICE_NOTE}
        rows={2}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("placeholder")}
        className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium resize-none focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40 disabled:opacity-40"
      />

      <div className="flex items-start justify-between gap-4">
        <p className="text-[10px] text-fg-40 leading-relaxed">{t("limitHint")}</p>
        <span className="text-[10px] text-fg-40 tabular-nums shrink-0">{used}/{MAX_CUSTOM_INVOICE_NOTE}</span>
      </div>
    </div>
  );
}
