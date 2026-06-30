import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getImpersonationId } from "@/lib/admin";

export const runtime = "edge";

async function resolveTargetUser(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return { error: "Unauthorized", status: 401 as const };
    let targetUserId = userId;
    if (await isAdmin(userId)) {
        const impersonationId = await getImpersonationId(request);
        if (impersonationId) targetUserId = impersonationId;
    }
    return { userId, targetUserId };
}

export async function GET(request: NextRequest) {
    const authResult = await resolveTargetUser(request);
    if ("error" in authResult) return NextResponse.json({ error: authResult.error }, { status: authResult.status });

    const { env } = getRequestContext();
    const db = (env as any).DB;
    if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

    // Credentials may be stored under source_kind='stripe' (route normalisation)
    // regardless of the actual wizard (lodgify/stripe). Mirror the same lookup.
    const rawSource = new URL(request.url).searchParams.get("source_kind") ?? "stripe";
    const sourceKind = rawSource === "shopify" ? "shopify" : "stripe";

    const row: any = await db.prepare(
        `SELECT destination_config_json FROM connections
         WHERE user_id = ? AND source_kind = ? AND destination_kind = 'moloni' LIMIT 1`
    ).bind(authResult.targetUserId, sourceKind).first();

    if (!row?.destination_config_json) {
        return NextResponse.json({ error: "Moloni credentials not found — save Step 2 first." }, { status: 404 });
    }

    const cfg = JSON.parse(row.destination_config_json);
    const baseUrl = cfg.moloni_environment === "sandbox"
        ? "https://apidemo.moloni.pt/v1"
        : "https://api.moloni.pt/v1";

    try {
        const ac = new AbortController();
        const tId = setTimeout(() => ac.abort(), 10_000);

        const tokenUrl = new URL(`${baseUrl}/grant/`);
        tokenUrl.searchParams.set("grant_type", "password");
        tokenUrl.searchParams.set("client_id", String(cfg.moloni_client_id ?? ""));
        tokenUrl.searchParams.set("client_secret", String(cfg.moloni_client_secret ?? ""));
        tokenUrl.searchParams.set("username", String(cfg.moloni_username ?? ""));
        tokenUrl.searchParams.set("password", String(cfg.moloni_password ?? ""));

        const tokenRes = await fetch(tokenUrl.toString(), {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            signal: ac.signal,
        });
        if (!tokenRes.ok) {
            clearTimeout(tId);
            const err: any = await tokenRes.json().catch(() => ({}));
            return NextResponse.json({ error: `Moloni auth failed (${tokenRes.status}): ${err?.error_description ?? err?.message ?? "check credentials"}` }, { status: 502 });
        }
        const tokenData: any = await tokenRes.json();
        const token = tokenData?.access_token;
        if (!token) { clearTimeout(tId); return NextResponse.json({ error: "Moloni auth returned no token" }, { status: 502 }); }

        const companiesRes = await fetch(
            `${baseUrl}/companies/getAll/?access_token=${encodeURIComponent(token)}&json=true`,
            { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" }, body: "", signal: ac.signal }
        );
        clearTimeout(tId);
        const data: any = await companiesRes.json().catch(() => []);
        const companies = Array.isArray(data)
            ? data.map((c: any) => ({ id: String(c.id), name: String(c.name ?? c.company_name ?? c.id) }))
            : [];

        return NextResponse.json({ companies });
    } catch (e: any) {
        const msg = e?.name === "AbortError" ? "Moloni API timeout — try again" : (e?.message ?? "unknown");
        console.error("[Moloni companies]", msg);
        return NextResponse.json({ error: msg }, { status: 502 });
    }
}
