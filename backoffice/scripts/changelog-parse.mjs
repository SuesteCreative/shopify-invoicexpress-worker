// The changelog parser, kept apart from the script that runs it.
//
// Its own module for one reason: changelog.test.ts imports it to check that the
// generated files still match CHANGELOG.md, and a file carrying a shebang
// cannot be imported by the test runner. The parser is a module; sync-version
// is a script that uses it.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const changelogPath = resolve(here, "..", "..", "CHANGELOG.md");

/**
 * Entry headings, across every format the file has used:
 *   ## 💎 Version 11.1.0 — Auditoria por regime — September 12, 2026
 *   ## 💎 Version 3.2.0 (The Bulletproof Engine) - March 1, 2026
 *   ## 📅 Version 1.1.2 - February 28, 2026
 */
const HEADING = /^##\s+(?:(\S+)\s+)?Version\s+([\d.]+)\s*(.*)$/;
const DATE_TAIL =
    /(?:[—–-]\s*)?((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4})\s*$/;
const RELEASE_MARKER = /^<!--\s*release:\s*([0-9a-f]{7,40})\s*-->$/i;
// The one section written for the merchant. Its bullets are the whole of the
// customer-facing feed; an entry without it never reaches a merchant at all.
const MERCHANT_HEADING = "Para o comerciante";

/**
 * Exported so a test can run the REAL parser over the REAL changelog and compare
 * it to the committed generated file. Reimplementing this in a test would be a
 * second expression of the same rule, and the copy that drifts is always the one
 * nobody is watching.
 */
export function parse(markdown) {
    const lines = markdown.split(/\r?\n/);
    const entries = [];
    let current = null;
    let fence = null; // lines of the fenced block being collected, if any
    let inMerchant = false;

    for (const line of lines) {
        if (fence) {
            if (line.trim().startsWith("```")) {
                current?.body.push({ t: "code", text: fence.join("\n") });
                fence = null;
            } else {
                fence.push(line);
            }
            continue;
        }
        if (current && line.trim().startsWith("```")) {
            fence = [];
            continue;
        }

        const head = line.match(HEADING);
        if (head) {
            if (current) entries.push(current);
            const [, emoji, version, rest] = head;
            let title = rest.trim();
            let date = "";
            const tail = title.match(DATE_TAIL);
            if (tail) {
                date = tail[1];
                title = title.slice(0, tail.index).trim();
            }
            // "— Landing Redesign" / "(The Bulletproof Engine)" / "" all reduce
            // to the bare title.
            title = title.replace(/^[—–-]\s*/, "").replace(/^\((.*)\)$/, "$1").trim();
            current = {
                version,
                emoji: emoji ?? "",
                title,
                date,
                commit: "",
                highlight: false,
                body: [],
                publicBody: [],
            };
            inMerchant = false;
            continue;
        }
        if (!current) continue;

        const marker = line.match(RELEASE_MARKER);
        if (marker) {
            current.commit = marker[1];
            continue;
        }

        const text = line.trim();
        if (!text) continue;
        if (text.startsWith("### ")) {
            const heading = text.slice(4).trim();
            inMerchant = heading === MERCHANT_HEADING;
            current.body.push({ t: "h", text: heading });
        } else if (/^[-*]\s+/.test(text)) {
            const block = { t: "li", text: text.replace(/^[-*]\s+/, "") };
            current.body.push(block);
            if (inMerchant) current.publicBody.push(block);
        } else {
            current.body.push({ t: "p", text });
            if (text.startsWith("**Destaque")) current.highlight = true;
        }
    }
    if (current) entries.push(current);
    return entries;
}
