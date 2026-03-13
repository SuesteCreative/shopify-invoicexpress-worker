export async function verifyShopifyWebhook(
    request: Request,
    secret: string
): Promise<boolean> {
    const hmac = request.headers.get("X-Shopify-Hmac-Sha256");
    if (!hmac) return false;

    const body = await request.clone().text();
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"]
    );

    const signature = new Uint8Array(
        atob(hmac)
            .split("")
            .map((c) => c.charCodeAt(0))
    );

    return await crypto.subtle.verify(
        "HMAC",
        key,
        signature,
        encoder.encode(body)
    );
}
