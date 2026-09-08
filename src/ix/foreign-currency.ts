import { platformError } from "../services/platform-error";
import type { Normalized } from "../api/normalize-shopify";

/**
 * Restating a foreign-currency sale in euros, when the payment processor never
 * converted it.
 *
 * InvoiceXpress issues in the account's own currency — for a Portuguese account
 * the euro, by law. `currency_code` + `rate` on the create body do NOT convert
 * anything: IX keeps the document's value in euros and prints a second figure
 * beside it, derived as `total * rate` (measured against the sandbox on
 * 2026-09-08, and the reason the proxy schema names both fields). So a sale of
 * 19,95 AUD sent through as-is becomes a 19,95 EUR document — the money on a
 * fiscal document simply wrong, by about 80% in that example.
 *
 * The Stripe source already handles the case where Stripe itself converted:
 * it reads the rate off the payment's own `balance_transaction`, which is the
 * only rate that agrees with the merchant's bank statement. But an account that
 * holds a BALANCE PER CURRENCY never converts — WHM's Stripe account settles
 * AUD in AUD, USD in USD, with `exchange_rate: null` on every balance
 * transaction — so that path finds nothing to do and the foreign number goes
 * out labelled as euros. That is 33 of WHM's last 89 payments.
 *
 * When there is no settlement rate, the rate has to come from somewhere, and
 * for Portuguese VAT that somewhere is the ECB daily reference rate for the
 * document's date (art. 49.º CIVA accepts the ECB rate). This module fetches
 * exactly that, converts the order in place, and records what was paid so the
 * document can still print the original currency.
 *
 * It fails CLOSED. A rate that cannot be fetched throws, the order stays
 * visibly unbilled, and the queue retries — because the alternative is issuing
 * a certified document for the wrong amount, and that one cannot be taken back.
 */

/** What the buyer actually paid, and how it was turned into euros. */
export interface EurRestatement {
  /** ISO 4217 of what the buyer paid in. */
  code: string;
  /** The amount paid, in that currency. */
  amount: number;
  /** Foreign units per euro, six decimals — what IX prints the second figure with. */
  rate: number;
  /** Multiply a foreign amount by this to get euros. The credit path needs it. */
  factor: number;
  /** Where the rate came from, for the log line and the audit trail. */
  source: string;
}

export type RateFetcher = (code: string, date: string) => Promise<{ rate: number; source: string }>;

const round2 = (n: number) => Math.round(n * 100) / 100;

// Rates for a past date never change, so one lookup per (date, currency) is
// enough for the isolate's lifetime. Cold starts re-fetch, which is fine.
const rateCache = new Map<string, { rate: number; source: string }>();

/**
 * The ECB reference rate for one currency on one date, via Frankfurter (which
 * republishes the ECB's own daily fixings, no key, historical).
 *
 * The ECB does not publish on weekends or Portuguese-relevant holidays;
 * Frankfurter answers those with the most recent fixing before the date asked
 * and says so in `date`, which is the same thing an accountant does by hand.
 */
export async function ecbRateForDate(code: string, date: string): Promise<{ rate: number; source: string }> {
  const key = `${date}:${code}`;
  const cached = rateCache.get(key);
  if (cached) return cached;

  const url = `https://api.frankfurter.dev/v1/${encodeURIComponent(date)}?base=EUR&symbols=${encodeURIComponent(code)}`;
  let body: any;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw platformError(
        `Não foi possível obter a taxa de câmbio EUR→${code} para ${date} `
        + `(BCE respondeu ${res.status}). A venda não foi facturada para não sair com o valor errado.`,
      );
    }
    body = await res.json();
  } catch (e: any) {
    // A thrown platformError from the block above passes through untouched; a
    // network failure becomes one, with the same meaning.
    if (e?.message?.includes("taxa de câmbio")) throw e;
    throw platformError(
      `Não foi possível obter a taxa de câmbio EUR→${code} para ${date} (${e?.message ?? e}). `
      + `A venda não foi facturada para não sair com o valor errado.`,
    );
  }

  const rate = Number(body?.rates?.[code]);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw platformError(
      `O BCE não publica taxa para ${code} (data ${date}). A venda não foi facturada `
      + `para não sair com o valor errado.`,
    );
  }

  const answer = { rate, source: `ECB ${String(body?.date ?? date)}` };
  rateCache.set(key, answer);
  return answer;
}

/**
 * Convert an order's money into euros, in place.
 *
 * Returns null — meaning "nothing to do" — for a sale already in euros and for
 * one the source has already restated (`paid_in_foreign_currency` set, which is
 * how the Stripe settlement path leaves it). Anything else is converted at the
 * ECB rate for the order's own date.
 *
 * Line by line, then the residual onto the biggest line: rounding each unit
 * price independently leaves the sum a cent or two off the converted total, and
 * the reconcile guard rejects the document over exactly that.
 */
export async function restateOrderInEur(
  order: Normalized["order"],
  deps?: { fetchRate?: RateFetcher },
): Promise<EurRestatement | null> {
  const code = String((order as any).currency ?? "").trim().toUpperCase();
  if (!code || code === "EUR") return null;

  // Already restated by the source (Stripe converted and told us the rate).
  // Converting again would divide the sale by the rate twice.
  if ((order as any).paid_in_foreign_currency) return null;

  const paidTotal = round2(Number(order.total));
  if (!(paidTotal > 0)) return null;

  const items: any[] = Array.isArray(order.items) ? order.items : [];
  if (items.length === 0) return null;

  const date = String(order.created_at ?? "").slice(0, 10) || new Date().toISOString().slice(0, 10);
  const fetchRate = deps?.fetchRate ?? ecbRateForDate;
  const { rate, source } = await fetchRate(code, date);

  const idealTotal = round2(paidTotal / rate);
  if (!(idealTotal > 0)) {
    throw platformError(
      `Conversão de ${paidTotal} ${code} para euros deu ${idealTotal} (taxa ${rate}). `
      + `A venda não foi facturada.`,
    );
  }
  const factor = 1 / rate;

  for (const item of items) {
    item.unit_price = round2(Number(item.unit_price ?? 0) * factor);
    item.unit_price_calculated = item.unit_price;
    item.subtotal_calculated = item.unit_price;
    if (typeof item.discount_allocation_amount === "number") {
      item.discount_allocation_amount = round2(item.discount_allocation_amount * factor);
    }
    if (item.tax && typeof item.tax.unit_amount === "number") {
      item.tax.unit_amount = round2(item.tax.unit_amount * factor);
    }
  }

  // The euro total is the SUM OF THE CONVERTED LINES, not the converted total.
  //
  // The settlement path in the Stripe source does the opposite — it forces the
  // lines onto the settled amount, pushing the rounding residual onto the
  // biggest line — and it is right to: there the euro figure is what Stripe
  // actually paid out, so it is the lines that have to give. Here nobody's bank
  // statement holds a euro figure; it is derived. Forcing the lines onto a
  // separately-rounded total is what leaves a document whose lines add up to a
  // cent less than its own total, and no unit price at two decimals can absorb
  // an arbitrary cent across a quantity of three at 23%.
  //
  // So the lines are the truth and the total follows them. The result differs
  // from the ideal conversion by at most a cent, which is the rounding of the
  // conversion itself, and the document is internally exact.
  const grossOf = (it: any) =>
    Number(it.unit_price) * Number(it.quantity ?? 1) * (1 + Number(it.tax?.value ?? 0) / 100);
  const eurTotal = round2(items.reduce((acc, it) => acc + grossOf(it), 0));
  if (!(eurTotal > 0)) {
    throw platformError(
      `Conversão de ${paidTotal} ${code} para euros deu linhas que somam ${eurTotal}. `
      + `A venda não foi facturada.`,
    );
  }

  order.total = eurTotal;
  (order as any).total_calculated = eurTotal;
  (order as any).currency = "EUR";
  (order as any).shop_currency = "EUR";
  // Six decimals, so the figure IX prints (total * rate) lands back on what the
  // buyer actually paid. Two decimals of rate are worth cents on a large sale.
  const printedRate = Math.round((paidTotal / eurTotal) * 1e6) / 1e6;
  (order as any).paid_in_foreign_currency = { code, amount: paidTotal, rate: printedRate };

  console.log(`[IX] ${paidTotal} ${code} restated as ${eurTotal} EUR (${source}, rate ${rate})`);
  return { code, amount: paidTotal, rate: printedRate, factor, source };
}
