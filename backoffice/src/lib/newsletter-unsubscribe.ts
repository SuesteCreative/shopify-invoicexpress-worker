/**
 * The newsletter's unsubscribe link, verified.
 *
 * The worker signs `<email>.<signature>` with ADMIN_API_KEY when it sends
 * (src/services/newsletter.ts, unsubscribeToken). This is the other half, and
 * src/services/newsletter.test.ts checks the two still agree. The token is the
 * whole authority: whoever holds it can stop that one address receiving
 * newsletters, which is what it is for, and it can do nothing else.
 */

const LABEL = "newsletter-unsubscribe:";

/** The address the token was signed for, or null for anything that does not verify. */
export async function verifyUnsubscribeToken(secret: string, token: string): Promise<string | null> {
    const [emailPart, sigPart, extra] = String(token ?? "").split(".");
    if (!secret || !emailPart || !sigPart || extra !== undefined) return null;

    let email: string;
    let signature: Uint8Array<ArrayBuffer>;
    try {
        email = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(fromB64url(emailPart));
        signature = fromB64url(sigPart);
    } catch {
        return null;
    }

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    // subtle.verify compares in constant time; a hand-rolled === would not.
    const ok = await crypto.subtle.verify("HMAC", key, signature, enc.encode(LABEL + email));
    return ok ? email : null;
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
    const binary = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
