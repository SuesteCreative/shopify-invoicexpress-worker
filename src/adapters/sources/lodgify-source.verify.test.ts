import { describe, it, expect } from "vitest";
import { LodgifySource } from "./lodgify-source";

/**
 * Lodgify's webhook signature, as Lodgify documents it: header `ms-signature`,
 * format `sha256=SIGNATURE`, HMAC-SHA256 of the raw body with the webhook's own
 * secret, and "the header will be Uppercase". The check compared lowercase hex
 * exactly and refused every real delivery.
 */

async function hmacHex(secret: string, body: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, enc.encode(body));
    return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const SECRET = "test-webhook-secret";
const BODY = JSON.stringify({ action: "booking_change", booking: { id: 123456, status: "Booked" } });

describe("LodgifySource.verifyWebhook", () => {
    const source = new LodgifySource();

    it("accepts the documented header: sha256= and uppercase hex", async () => {
        const hex = await hmacHex(SECRET, BODY);
        expect(await source.verifyWebhook(BODY, `sha256=${hex.toUpperCase()}`, SECRET)).toBe(true);
    });

    it("accepts the same signature however its case or prefix is written", async () => {
        const hex = await hmacHex(SECRET, BODY);
        expect(await source.verifyWebhook(BODY, `sha256=${hex}`, SECRET)).toBe(true);
        expect(await source.verifyWebhook(BODY, `SHA256=${hex.toUpperCase()}`, SECRET)).toBe(true);
        expect(await source.verifyWebhook(BODY, hex.toUpperCase(), SECRET)).toBe(true);
    });

    it("refuses a wrong secret, a changed body and a missing header", async () => {
        const hex = await hmacHex(SECRET, BODY);
        expect(await source.verifyWebhook(BODY, `sha256=${hex.toUpperCase()}`, "another-secret")).toBe(false);
        expect(await source.verifyWebhook(BODY.replace("123456", "654321"), `sha256=${hex.toUpperCase()}`, SECRET)).toBe(false);
        expect(await source.verifyWebhook(BODY, "", SECRET)).toBe(false);
        expect(await source.verifyWebhook(BODY, "sha256=", SECRET)).toBe(false);
    });
});
