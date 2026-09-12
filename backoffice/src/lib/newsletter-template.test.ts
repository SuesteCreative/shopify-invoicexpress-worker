import { describe, it, expect } from "vitest";
import { fill, requiredLegalOk, unknownVars, standardVars, SENDER } from "./newsletter-template";

/**
 * The failure this file exists to prevent: a substitution that eats Resend's
 * triple-brace tags. It cannot be caught by reading the code — both forms look
 * alike — and it is invisible until the mail is delivered, at which point the
 * unsubscribe link is a literal string in a stranger's inbox.
 */

describe("fill", () => {
    it("replaces ours and leaves Resend's untouched", () => {
        const html = `<p>Olá{{GREETING_NAME}}, <a href="{{{RESEND_UNSUBSCRIBE_URL}}}">sair</a></p>`;
        const out = fill(html);
        expect(out).toContain("{{{RESEND_UNSUBSCRIBE_URL}}}");
        expect(out).toContain("{{{contact.first_name|}}}");
        expect(out).not.toContain("{{GREETING_NAME}}");
    });

    it("leaves a triple alone even when its inner name looks like ours", () => {
        // The trap: {{{FOO}}} contains the substring {{FOO}} at offset 1.
        expect(fill("{{{FOO}}}", { FOO: "x" })).toBe("{{{FOO}}}");
        expect(fill("a {{{FOO}}} b", { FOO: "x" })).toBe("a {{{FOO}}} b");
        expect(fill("{{FOO}} {{{FOO}}}", { FOO: "x" })).toBe("x {{{FOO}}}");
    });

    it("empties an unknown placeholder instead of shipping it", () => {
        expect(fill("[{{NOPE}}]", {})).toBe("[]");
    });

    it("fills the greeting so an unknown name collapses cleanly", () => {
        // "Olá{{GREETING_NAME}}," must be able to become "Olá," and never "Olá ,".
        // The fallback in the Resend tag is empty, and our value carries the space.
        expect(standardVars().GREETING_NAME).toBe(" {{{contact.first_name|}}}");
    });
});

describe("requiredLegalOk", () => {
    const lawful = `
      <p>Olá{{GREETING_NAME}}</p>
      <a href="{{{RESEND_UNSUBSCRIBE_URL}}}">Cancelar subscrição</a>
      <p>{{SENDER_COMPANY}} · {{SENDER_ADDRESS}} · NIF {{SENDER_NIF}}</p>
      <a href="https://rioko.online/pt/privacy">Privacidade</a>`;

    it("passes copy that carries an opt-out, a sender and a privacy link", () => {
        expect(requiredLegalOk(fill(lawful))).toBeNull();
    });

    it("refuses copy with no way to unsubscribe", () => {
        const without = fill(lawful).replace("{{{RESEND_UNSUBSCRIBE_URL}}}", "#");
        expect(requiredLegalOk(without)).toMatch(/cancelamento/);
    });

    it("refuses copy that does not say who is writing", () => {
        const anonymous = fill(lawful).replace(SENDER.NIF, "");
        expect(requiredLegalOk(anonymous)).toMatch(/remetente/);
    });

    it("refuses copy with no privacy link", () => {
        const bare = fill(lawful).replace("https://rioko.online/pt/privacy", "#");
        expect(requiredLegalOk(bare)).toMatch(/privacidade/);
    });
});

describe("unknownVars", () => {
    it("names the typos, and does not count Resend's tags as typos", () => {
        const html = "{{GREETING_NAME}} {{SENDR_NAME}} {{{RESEND_UNSUBSCRIBE_URL}}} {{ALSO_WRONG}}";
        expect(unknownVars(html).sort()).toEqual(["ALSO_WRONG", "SENDR_NAME"]);
    });
});
