import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * No page tells a client a price it did not read from Stripe.
 *
 * Stripe→Moloni printed "5 €/mês + IVA" and Connect→Moloni reused the same two
 * strings, while both checkouts charged the current price. That 5 €/50 € is
 * real — it is what a migrated client's EXISTING subscription bills on — but it
 * is not a price we sell, so quoting it to somebody about to subscribe was an
 * advertised price nobody could get. The amounts came out of the markup once
 * before, on the billing card, and grew back on three wizards that nothing was
 * watching.
 *
 * So: on any surface that talks about a particular client's subscription, a
 * stated price is a test failure. The figure has to come from
 * `/api/billing/price` (what the checkout will charge) or from the
 * subscription's own `plan_price` (what this client actually pays). Landing and
 * pricing pages are deliberately out of scope — they advertise the list price
 * to the world, which is a sentence, not a client's bill.
 */

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** An amount of money next to a billing period: "5 €/mês", "€75/year",
 *  "7,50 € por mês". A bare amount is not enough — the seat fee (1,50 €, once)
 *  and the simplified-invoice ceiling (1000 €) are facts, not plan prices. */
const AMOUNT = /(?:€\s*\d[\d.,]*|\d[\d.,]*\s*€|\d[\d.,]*\s*EUR)/i;
const PER_PERIOD = /(?:\/\s*(?:m[êe]s|ano|month|year)|por\s+(?:m[êe]s|ano)|per\s+(?:month|year)|a\s+month|a\s+year)/i;

export function statesAPlanPrice(text: string): boolean {
    // A placeholder is the fix, not the bug: "{amount}/mês" is filled in by
    // whoever resolved the price.
    if (/\{(?:price|amount|pct)\}/.test(text)) return false;
    return AMOUNT.test(text) && PER_PERIOD.test(text);
}

/** Comments are prose about the bug, and several of them quote the old prices
 *  on purpose — including the ones right above this rule's own fixes. */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n"'`]*\/\/.*$/gm, "");
}

function walk(dir: string, out: string[] = []): string[] {
    if (!existsSync(dir)) return out;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(full, out);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
    }
    return out;
}

/** Everywhere a specific client is told what their integration costs. */
function billingSurfaces(): string[] {
    return [
        ...walk(`${SRC}app/[locale]/(dashboard)/integrations`),
        `${SRC}app/[locale]/(dashboard)/faturacao/page.tsx`,
        ...walk(`${SRC}components/onboarding`),
        `${SRC}components/SubscriptionCard.tsx`,
    ].filter((f) => existsSync(f));
}

const pt = JSON.parse(readFileSync(`${SRC}messages/pt.json`, "utf8"));
const en = JSON.parse(readFileSync(`${SRC}messages/en.json`, "utf8"));

function messageAt(messages: any, path: string): unknown {
    return path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), messages);
}

/** A namespace may be asked for wholesale, so a price anywhere under the key
 *  that is referenced counts. */
function anyValueStatesAPlanPrice(node: unknown): boolean {
    if (typeof node === "string") return statesAPlanPrice(node);
    if (node && typeof node === "object") return Object.values(node).some(anyValueStatesAPlanPrice);
    return false;
}

/** `const tB = useTranslations("faturacao")` → tB resolves under `faturacao`. */
function namespacesByAlias(src: string): Map<string, string> {
    const alias = new Map<string, string>();
    const direct = /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*["'`]([\w.]+)["'`]\s*\)/g;
    const viaOptions = /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?getTranslations\(\s*\{[^}]*namespace:\s*["'`]([\w.]+)["'`]/g;
    for (const m of src.matchAll(direct)) alias.set(m[1], m[2]);
    for (const m of src.matchAll(viaOptions)) alias.set(m[1], m[2]);
    return alias;
}

function offencesIn(file: string): string[] {
    const raw = readFileSync(file, "utf8");
    const src = stripComments(raw);
    const where = file.slice(SRC.length);
    const found: string[] = [];

    for (const [alias, namespace] of namespacesByAlias(src)) {
        for (const m of src.matchAll(new RegExp(`\\b${alias}\\(\\s*["'\`]([\\w.]+)["'\`]`, "g"))) {
            const key = `${namespace}.${m[1]}`;
            for (const [lang, messages] of [["pt", pt], ["en", en]] as const) {
                const value = messageAt(messages, key);
                if (value !== undefined && anyValueStatesAPlanPrice(value)) {
                    const line = src.slice(0, m.index).split("\n").length;
                    found.push(`${where}:${line} prints ${lang}.${key} = ${JSON.stringify(value)}`);
                }
            }
        }
    }

    for (const m of src.matchAll(/[^\n]*(?:€\s*\d[\d.,]*|\d[\d.,]*\s*€)[^\n]*/g)) {
        if (statesAPlanPrice(m[0])) {
            const line = src.slice(0, m.index).split("\n").length;
            found.push(`${where}:${line} states a price in the markup: ${m[0].trim().slice(0, 70)}`);
        }
    }
    return found;
}

describe("a stated subscription price", () => {
    it("recognises a plan price, and only a plan price", () => {
        // Without this the rule below can rot into a test that passes because
        // it stopped looking.
        expect(statesAPlanPrice("5 €/mês + IVA")).toBe(true);
        expect(statesAPlanPrice("€50/year + VAT")).toBe(true);
        expect(statesAPlanPrice("7,50 € por mês, ou 75 € por ano")).toBe(true);
        expect(statesAPlanPrice("Anual · 75€/ano")).toBe(true);
        // Resolved at runtime: the whole point.
        expect(statesAPlanPrice("{amount}€/mês + IVA")).toBe(false);
        expect(statesAPlanPrice("poupa {pct}%")).toBe(false);
        // Not plan prices: the one-off seat, the legal ceiling, a zero.
        expect(statesAPlanPrice("cada lugar seguinte desbloqueia-se por 1,50 € + IVA")).toBe(false);
        expect(statesAPlanPrice("válido para B2C português até 1000€")).toBe(false);
        expect(statesAPlanPrice("0 €")).toBe(false);
    });

    it("finds the surfaces it is supposed to watch", () => {
        const files = billingSurfaces();
        expect(files.length).toBeGreaterThanOrEqual(12);
        expect(files.some((f) => f.endsWith("integrations/stripe-moloni/page.tsx"))).toBe(true);
        expect(files.some((f) => f.endsWith("components/SubscriptionCard.tsx"))).toBe(true);
    });

    it("appears nowhere a client is told what their own integration costs", () => {
        const offences = billingSurfaces().flatMap(offencesIn);
        expect(offences, `read the price from /api/billing/price or the subscription's plan_price:\n${offences.join("\n")}`)
            .toEqual([]);
    });
});
