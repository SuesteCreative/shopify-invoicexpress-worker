import { NextRequest, NextResponse } from "next/server";
import { getRequestContext } from "@cloudflare/next-on-pages";

export const runtime = "edge";

export async function GET(req: NextRequest) {
    const key = req.nextUrl.searchParams.get("key");
    const expected = process.env.INTERNAL_GATE_API_KEY || process.env.ADMIN_API_KEY;

    // Allow either gate key or admin key — also try via getRequestContext if process.env empty
    let allowed = expected && key === expected;
    if (!allowed) {
        try {
            const ctxKey = (getRequestContext().env as any).INTERNAL_GATE_API_KEY || (getRequestContext().env as any).ADMIN_API_KEY;
            if (ctxKey && key === ctxKey) allowed = true;
        } catch {}
    }
    if (!allowed) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const interesting = [
        "STRIPE_SECRET_KEY", "STRIPE_PUBLIC_KEY", "STRIPE_WEBHOOK_SECRET",
        "STRIPE_PRICE_MONTHLY_LOOKUP", "STRIPE_PRICE_YEARLY_LOOKUP",
        "KAPTA_IX_ACCOUNT_NAME", "KAPTA_IX_API_KEY", "KAPTA_IX_ENV",
        "EARLY_BIRD_TRIAL_END", "SUCCESS_REDIRECT_URL", "CANCEL_REDIRECT_URL",
        "INTERNAL_GATE_API_KEY", "CRON_SECRET", "ADMIN_API_KEY",
        "CLERK_SECRET_KEY", "CLERK_WEBHOOK_SECRET",
    ];

    const result: Record<string, { proc: string; ctx: string }> = {};
    let ctxEnv: any = null;
    try { ctxEnv = getRequestContext().env; } catch { }

    for (const name of interesting) {
        const procVal = process.env[name];
        const ctxVal = ctxEnv ? ctxEnv[name] : undefined;
        result[name] = {
            proc: procVal ? `set(${procVal.length}c, starts=${procVal.slice(0, 6)})` : "MISSING",
            ctx: ctxVal ? `set(${String(ctxVal).length}c, starts=${String(ctxVal).slice(0, 6)})` : "MISSING",
        };
    }

    const ctxKeys = ctxEnv ? Object.keys(ctxEnv).sort() : [];
    const procKeys = Object.keys(process.env).filter(k => !k.startsWith("_") && !k.startsWith("npm_")).sort();

    return NextResponse.json({
        targeted: result,
        ctx_all_keys: ctxKeys,
        proc_all_keys: procKeys,
    });
}
