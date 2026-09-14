"use client";

import { Info } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ConnectionFiscal } from "@/lib/connection-fiscal";

/**
 * What this business is REGISTERED for, declared by the merchant.
 *
 * Not settings and not rules. The regime a sale falls under is a fact about the
 * buyer — which country, whether they are a VAT-registered business, what VIES
 * says — and the worker decides it. The one thing a merchant knows that we
 * cannot is which regimes they are actually registered under, and that is all
 * this asks.
 *
 * Each answer authorises exactly one rung of the VAT decision to move money.
 * Absent means off, and absent is the default: a merchant who never opens this
 * card keeps being invoiced exactly as they are today.
 *
 * Rendered from one component in every wizard that owns an InvoiceXpress or
 * Moloni connection. Eight copies of this block is how the labels elsewhere
 * drifted apart — and copy that states a legal consequence is the worst possible
 * thing to have eight versions of.
 */

interface Props {
  value: ConnectionFiscal;
  /** Emits ONLY the key that changed, so a key never stated stays never stated. */
  onChange: (patch: Partial<ConnectionFiscal>) => void;
  disabled?: boolean;
  /** Vendus cannot express a foreign rate, so OSS is not offered for it. */
  destination: "invoicexpress" | "moloni";
}

const Toggle = ({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) => (
  <button
    type="button"
    onClick={() => !disabled && onClick()}
    disabled={disabled}
    aria-pressed={on}
    className={`w-12 h-6 rounded-full transition-all duration-500 relative ring-1 ring-inset ring-sunken shrink-0 disabled:opacity-40 ${on ? "bg-accent-hot" : "bg-track-off"}`}
  >
    <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all duration-500 ${on ? "left-7" : "left-1"}`} />
  </button>
);

export default function TaxRegistrations({ value, onChange, disabled, destination }: Props) {
  const t = useTranslations("taxRegistrations");

  const rows: Array<{ key: "oss_engine" | "pt_regional_rates" | "b2b_reverse_charge_pipeline"; i18n: string }> = [
    { key: "b2b_reverse_charge_pipeline", i18n: "reverseCharge" },
    { key: "oss_engine", i18n: "oss" },
    { key: "pt_regional_rates", i18n: "ptRegional" },
  ];

  const anyOn = rows.some((r) => value[r.key] === true);

  // Unset behaves as M40 today, so show that rather than a blank that would read
  // as "no code" on a document that will carry one.
  const selectedExportCode = (value.oss_export_exemption_code ?? "").trim() || "M40";
  const isKnownExportCode = selectedExportCode === "M40" || selectedExportCode === "M05";

  return (
    <div className="md:col-span-2 glass p-5 sm:p-8 rounded-[2rem] border-hairline space-y-5">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-soon/10 rounded-xl"><Info className="w-4 h-4 text-soon" /></div>
        <div>
          <h3 className="font-bold text-sm tracking-tight">{t("title")}</h3>
          <p className="text-[10px] text-fg-40 font-medium uppercase tracking-wider mt-0.5">{t("subtitle")}</p>
        </div>
      </div>

      <p className="text-[11px] text-fg-60 leading-relaxed">{t("intro")}</p>

      <div className="space-y-3">
        {rows.map((r) => (
          <div key={r.key} className="flex items-start justify-between gap-4 py-3 border-b border-hairline last:border-0">
            <div className="min-w-0">
              <p className="font-bold text-sm">{t(`${r.i18n}.label`)}</p>
              <p className="text-[11px] text-fg-40 leading-relaxed mt-1">{t(`${r.i18n}.help`)}</p>
            </div>
            <Toggle
              on={value[r.key] === true}
              disabled={disabled}
              onClick={() => onChange({ [r.key]: !(value[r.key] === true) } as Partial<ConnectionFiscal>)}
            />
          </div>
        ))}
      </div>

      {/* Only worth asking once something zero-rates a sale outside the EU. */}
      {anyOn && (
        <div className="space-y-2 pt-1">
          <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1">
            <span className="w-1 h-1 rounded-full bg-accent" />{t("exportCode.label")}
          </label>
          {/* A choice between two articles, not a code to type.
            *
            * M40 is `autoliquidação art. 6.º n.º 6 a), a contrário` and belongs
            * to SERVICES whose place of supply is outside Portugal; M05 is
            * `isento art. 14.º CIVA` and belongs to exported GOODS. Nothing in a
            * payment says which a line is, so the merchant is the only one who
            * can answer — and a text box defaulting to M40 answered it for them,
            * silently, in favour of services. Bikini Books had US exports going
            * out under the wrong article for exactly that reason.
            *
            * An empty field already behaves as M40 (see `ossExemptionCode`), so
            * that is what an unset connection shows. Nothing is written until the
            * merchant actually picks, because `onChange` is what the wizard
            * carries and a key never stated must stay never stated.
            *
            * A value outside the two is kept and offered rather than snapped to
            * the nearest: somebody chose it, and a dropdown that quietly rewrites
            * a fiscal code would be worse than the box it replaces. */}
          <select
            value={selectedExportCode}
            disabled={disabled}
            onChange={(e) => onChange({ oss_export_exemption_code: e.target.value })}
            className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all"
          >
            <option value="M40">{t("exportCode.optionServices")}</option>
            <option value="M05">{t("exportCode.optionGoods")}</option>
            {!isKnownExportCode && (
              <option value={selectedExportCode}>{selectedExportCode}</option>
            )}
          </select>
          <p className="text-[10px] text-fg-40 ml-1">{t("exportCode.help")}</p>
        </div>
      )}

      {anyOn && (
        <p className="text-[11px] leading-relaxed font-medium text-soon/90 border-l-2 border-soon/40 pl-3">
          {t(destination === "moloni" ? "consequenceMoloni" : "consequence")}
        </p>
      )}
    </div>
  );
}
