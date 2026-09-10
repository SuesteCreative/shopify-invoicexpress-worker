import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/** The legal pages render every section through `t.rich(..., LEGAL_RICH)`.
 *  A tag that is not in that map throws at request time, and these routes are
 *  dynamic — the build renders neither, so nothing else catches it. The section
 *  numbers live inside the title strings too, so a renumber can silently leave a
 *  gap or a repeat (kapta.pt itself ships two sections numbered "5").
 *
 *  Keep in sync with LEGAL_RICH in app/[locale]/{terms,privacy}/page.tsx. */
const ALLOWED = ["b", "mail", "site", "br", "p", "ul", "li"];

const LOCALES = ["pt", "en"] as const;
const NAMESPACES = { terms: 14, privacy: 11 } as const;

const load = (locale: string) =>
    JSON.parse(readFileSync(`backoffice/src/messages/${locale}.json`, "utf8"));

describe("legal message catalogs", () => {
    for (const locale of LOCALES) {
        for (const [ns, count] of Object.entries(NAMESPACES)) {
            const sections = () => {
                const d = load(locale)[ns];
                return Object.keys(d)
                    .filter((k) => /^s\d+$/.test(k))
                    .map((k) => ({ key: k, ...d[k] }));
            };

            it(`${locale}/${ns}: uses only tags LEGAL_RICH defines`, () => {
                for (const s of sections()) {
                    for (const field of ["title", "body"]) {
                        const tags = [...String(s[field]).matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)]
                            .map((m) => m[1]);
                        for (const tag of tags) {
                            expect(ALLOWED, `${s.key}.${field} uses <${tag}>`).toContain(tag);
                        }
                    }
                }
            });

            it(`${locale}/${ns}: every rich tag is closed`, () => {
                for (const s of sections()) {
                    for (const tag of ALLOWED.filter((t) => t !== "br")) {
                        const body = String(s.body);
                        const open = body.split(`<${tag}>`).length - 1;
                        const close = body.split(`</${tag}>`).length - 1;
                        expect(open, `${s.key} <${tag}>`).toBe(close);
                    }
                }
            });

            it(`${locale}/${ns}: section numbers run 1..${count} with no gaps`, () => {
                const nums = sections().map((s) => Number(String(s.title).match(/^(\d+)\./)?.[1]));
                expect(nums).toEqual(Array.from({ length: count }, (_, i) => i + 1));
            });
        }
    }

    it("pt and en stay key-symmetric", () => {
        const keys = (o: Record<string, unknown>, p = ""): string[] =>
            Object.entries(o).flatMap(([k, v]) =>
                v && typeof v === "object"
                    ? [p + k, ...keys(v as Record<string, unknown>, `${p}${k}.`)]
                    : [p + k]
            );
        const pt = load("pt");
        const en = load("en");
        for (const ns of [...Object.keys(NAMESPACES), "landing"]) {
            expect(keys(pt[ns]).sort(), ns).toEqual(keys(en[ns]).sort());
        }
    });

    it("the footer's dispute link has a section to land on", () => {
        // Landing.tsx / ShopifyLanding.tsx link to /privacy#litigios, and
        // ANCHORS in privacy/page.tsx maps that id onto s10.
        const page = readFileSync(
            "backoffice/src/app/[locale]/privacy/page.tsx",
            "utf8"
        );
        const anchored = page.match(/ANCHORS[^=]*=\s*\{\s*(s\d+):\s*"litigios"/);
        expect(anchored, "no s<n>: 'litigios' entry in ANCHORS").toBeTruthy();
        const key = anchored![1];
        for (const locale of LOCALES) {
            expect(load(locale).privacy[key], `${locale} ${key}`).toBeTruthy();
        }
    });
});
