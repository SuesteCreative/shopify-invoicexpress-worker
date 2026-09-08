import { NextResponse } from "next/server";

export const runtime = "edge";

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const account = searchParams.get("account");
        const apiKey = searchParams.get("apiKey");
        const environment = searchParams.get("environment") || "production";

        if (!account || !apiKey) {
            return NextResponse.json({ error: "Missing account or apiKey" }, { status: 400 });
        }

        // `.app.` is not optional: the bare `{account}.invoicexpress.com` has no
        // DNS record (measured 2026-09-08), so this list came back empty for
        // every production account — during setup the merchant was offered no
        // series at all, and picked none.
        const isTestEnv = environment === "sandbox" || environment === "test" || environment === "macewindu";
        const suffix = isTestEnv ? ".macewindu.invoicexpress.com" : ".app.invoicexpress.com";
        const baseUrl = `https://${account}${suffix}`;

        const res = await fetch(`${baseUrl}/sequences.json?api_key=${apiKey}`, {
            headers: {
                "X-InvoiceXpress-API-Key": apiKey,
                "Accept": "application/json"
            }
        });

        if (!res.ok) {
            return NextResponse.json({ error: "Failed to fetch sequences" }, { status: res.status });
        }

        const data: any = await res.json();
        return NextResponse.json(data.sequences || []);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
