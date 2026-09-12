/**
 * Two kinds of placeholder live in the same HTML, and confusing them breaks a
 * campaign in a way nobody sees until it has been delivered.
 *
 *   {{VAR}}    ours. One value for the whole send, substituted here, before the
 *              HTML ever leaves for Resend.
 *   {{{VAR}}}  Resend's. It must arrive at the Broadcast API byte-for-byte, or
 *              the merchant reads a literal `{{{RESEND_UNSUBSCRIBE_URL}}}` in
 *              their inbox and has no way to unsubscribe — which is the one
 *              defect in a marketing email that is not merely embarrassing.
 *
 * So the substitution regex is written to be unable to see a triple, from either
 * side. `{{{X}}}` is skipped by the leading `(?!\{)` at its first brace and by
 * the trailing `(?!\})` at its second, and there is no third chance.
 *
 * The one merge tag we generate rather than pass through is the greeting:
 * {{GREETING_NAME}} resolves to Resend's own `{{{contact.first_name|}}}`. That
 * is how each merchant is greeted by name without us running a send loop — the
 * per-recipient part is done by the broadcast, from the contact we synced.
 */

/** `{{VAR}}`, never `{{{VAR}}}`. */
const OURS = /\{\{(?!\{)([A-Z_]+)\}\}(?!\})/g;

/** Whoever the mail comes from, as the law requires it to be identifiable.
 *  Taken verbatim from the legal pages (messages/pt.json, "legal" namespace). */
export const SENDER = {
    NAME: "Pedro Porto",
    COMPANY: "ABSOLUTEPIXEL UNIPESSOAL, LDA",
    ADDRESS: "Urbanização O Monte Lt1, Loja 11, 8200-428 Galé, Albufeira, Portugal",
    NIF: "516277421",
} as const;

/** Where a merchant finds their own referral link. Deliberately the same URL
 *  for every recipient: a personal link pasted into the body gets forwarded,
 *  and a forwarded personal link credits the wrong account. */
export const INVITE_PAGE = "https://rioko.online/pt/convidar";

/** Images must be hosted, not inlined: Gmail strips SVG data URIs and drops
 *  base64 over ~10KB on the web client. */
export const IMG_BASE = "https://rioko.online/images";

export function standardVars(): Record<string, string> {
    return {
        // Leading space on purpose: the copy reads "Olá{{GREETING_NAME}}," so an
        // unknown first name has to collapse to "Olá," and not "Olá ,".
        GREETING_NAME: " {{{contact.first_name|}}}",
        LINK_CONVITE: INVITE_PAGE,
        IMG_BASE,
        SENDER_NAME: SENDER.NAME,
        SENDER_COMPANY: SENDER.COMPANY,
        SENDER_ADDRESS: SENDER.ADDRESS,
        SENDER_NIF: SENDER.NIF,
    };
}

/**
 * Substitute our placeholders. An unknown `{{X}}` becomes empty rather than
 * being left visible — a stray placeholder in a customer's inbox is worse than
 * a missing word, and the preview is where a missing word gets noticed.
 */
export function fill(html: string, vars: Record<string, string> = standardVars()): string {
    return html.replace(OURS, (_m, name: string) => vars[name] ?? "");
}

/**
 * The last gate before a broadcast is created.
 *
 * Called on the FILLED html, on the worker side, because that is the copy that
 * gets sent. Returns null when the mail is lawful to send, otherwise the reason,
 * which the admin page shows instead of a send button.
 *
 * Livro de Reclamações is not required here: it belongs to the service pages and
 * to transactional mail (legalLinks()), not to a commercial email. What a
 * commercial email must carry is a working opt-out and an identifiable sender.
 */
export function requiredLegalOk(html: string): string | null {
    if (!html.includes("{{{RESEND_UNSUBSCRIBE_URL}}}")) {
        return "sem link de cancelamento: falta {{{RESEND_UNSUBSCRIBE_URL}}}";
    }
    if (!html.includes(SENDER.NIF) || !html.includes(SENDER.COMPANY)) {
        return "sem identificação do remetente: falta a empresa ou o NIF";
    }
    if (!html.includes("rioko.online/pt/privacy")) {
        return "sem ligação à política de privacidade";
    }
    return null;
}

/** Placeholders left in the html that nothing will fill. Shown in the preview so
 *  a typo is caught by eye, before anyone presses send. */
export function unknownVars(html: string, vars: Record<string, string> = standardVars()): string[] {
    const missing = new Set<string>();
    for (const m of html.matchAll(OURS)) {
        if (!(m[1] in vars)) missing.add(m[1]);
    }
    return [...missing];
}
