import { describe, it, expect } from "vitest";
import { identifyFile, safeFilename } from "./account-file-types";

/**
 * What a file is allowed to be is decided by reading it, never by what the
 * upload claimed. These are the cases that matter, and the SVG one is the
 * reason the check exists at all: an SVG is an XML document that can carry
 * <script>, it looks like an image in every listing, and serving one from the
 * admin's own origin hands a visitor's session to whoever uploaded it.
 */
const bytes = (...b: number[]) => new Uint8Array(b);
const text = (s: string) => new TextEncoder().encode(s);

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10);
const PDF = text("%PDF-1.7\n...");
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00);
const WEBP = new Uint8Array([...bytes(0x52, 0x49, 0x46, 0x46), 0, 0, 0, 0, ...bytes(0x57, 0x45, 0x42, 0x50)]);

describe("identifyFile", () => {
    it("recognises the kinds we store, and says which may render in place", () => {
        expect(identifyFile("foto.png", PNG)).toMatchObject({ contentType: "image/png", inline: true });
        expect(identifyFile("foto.jpg", JPEG)).toMatchObject({ contentType: "image/jpeg", inline: true });
        expect(identifyFile("foto.webp", WEBP)).toMatchObject({ contentType: "image/webp", inline: true });
        expect(identifyFile("fatura.pdf", PDF)).toMatchObject({ contentType: "application/pdf", inline: false });
        expect(identifyFile("mapa.xlsx", ZIP)).toMatchObject({ inline: false });
        expect(identifyFile("vendas.csv", text("data,valor\n2026-09-14,10"))).toMatchObject({ inline: false });
    });

    // The one that would actually hurt.
    it("refuses an SVG however it is dressed", () => {
        const svg = text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
        expect(identifyFile("logo.svg", svg)).toBeNull();
        expect(identifyFile("logo.svgz", svg)).toBeNull();
        // Valid UTF-8 with no NULs, so it would otherwise pass as text.
        expect(identifyFile("logo.txt", svg)).not.toBeNull();
        expect(identifyFile("logo.txt", svg)?.inline).toBe(false);
    });

    it("refuses HTML, which is a document that runs", () => {
        expect(identifyFile("nota.html", text("<html><script>x</script>"))).toBeNull();
        expect(identifyFile("nota.htm", text("<html>"))).toBeNull();
    });

    // Content and extension have to agree, or a PDF named .png would be served
    // back with an image content type and rendered in place.
    it("refuses a file whose bytes and name disagree", () => {
        expect(identifyFile("inocente.png", PDF)).toBeNull();
        expect(identifyFile("mapa.xlsx", PDF)).toBeNull();
        expect(identifyFile("arquivo.zip", ZIP)).toBeNull();
    });

    it("refuses what it cannot identify at all", () => {
        expect(identifyFile("coisa.bin", bytes(0x00, 0x01, 0x02))).toBeNull();
        expect(identifyFile("vazio.csv", new Uint8Array())).toBeNull();
        // Binary with a text extension: the NUL byte gives it away.
        expect(identifyFile("falso.csv", bytes(0x61, 0x00, 0x62))).toBeNull();
    });
});

describe("safeFilename", () => {
    it("keeps a name from escaping a path or a header", () => {
        expect(safeFilename("../../etc/passwd")).toBe("passwd");
        expect(safeFilename('fatura".pdf')).toBe("fatura.pdf");
        expect(safeFilename("C:\\Users\\pedro\\nota.pdf")).toBe("nota.pdf");
        expect(safeFilename("")).toBe("ficheiro");
    });
});
