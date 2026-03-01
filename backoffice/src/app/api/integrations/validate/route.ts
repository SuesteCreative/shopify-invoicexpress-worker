import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, getImpersonationId } from "@/lib/admin";

export const runtime = "edge";

export async function POST(request: NextRequest) {
    try {
        const { userId } = await auth();
        let targetUserId = userId;

        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const isSuperAdmin = await isAdmin(userId);
        if (isSuperAdmin) {
            const impId = await getImpersonationId(request);
            if (impId) targetUserId = impId;
        }

        const body = await request.json() as { type: "shopify" | "ix" };
        const { env } = getRequestContext();
        const db = (env as any).DB;

        // Fetch current config
        const config: any = await db.prepare("SELECT * FROM integrations WHERE user_id = ?").bind(targetUserId).first();
        if (!config) return NextResponse.json({ error: "No integration found" }, { status: 404 });

        let isValid = false;
        let errorMessage = "";

        if (body.type === "shopify") {
            let domain = config.shopify_domain || "";
            const token = config.shopify_token;
            const version = config.shopify_api_version || "2026-01";

            domain = domain.replace(/^https?:\/\//, "").replace(/\/$/, "");

            if (!domain || !token) return NextResponse.json({ error: "Missing Shopify credentials" }, { status: 400 });

            try {
                // Try several API versions as fallback for older stores/test stores
                const versions = [version, "2025-01", "2024-10", "2024-07", "2024-01"];
                let lastStatus = 0;

                for (const v of versions) {
                    const url = `https://${domain}/admin/api/${v}/shop.json`;
                    const res = await fetch(url, {
                        headers: {
                            "X-Shopify-Access-Token": token.trim(),
                            "Accept": "application/json"
                        }
                    });

                    lastStatus = res.status;
                    if (res.status === 200) {
                        isValid = true;
                        errorMessage = "";
                        break;
                    } else if (res.status === 401) {
                        errorMessage = "Token Inválido (shpat_...). Verifique se o App está instalado na Shopify.";
                        break;
                    } else {
                        try {
                            const data = await res.json() as any;
                            errorMessage = data.errors || `Erro na Shopify (${res.status})`;
                        } catch {
                            errorMessage = `Resposta Inválida da Shopify (${res.status})`;
                        }
                    }
                }

                if (!isValid && !errorMessage) {
                    errorMessage = `Falha na ligação (Status ${lastStatus}). Verifique o domínio da loja.`;
                }

            } catch (e: any) {
                errorMessage = `Erro de Rede: Verifique se o domínio ${domain} existe.`;
                isValid = false;
            }

            await db.prepare("UPDATE integrations SET shopify_authorized = ?, shopify_error = ? WHERE user_id = ?")
                .bind(isValid ? 1 : 0, errorMessage || null, targetUserId).run();

        } else if (body.type === "ix") {
            let account = (config.ix_account_name || "").trim();
            const apiKey = (config.ix_api_key || "").trim();
            const environment = config.ix_environment || "production";

            if (!account || !apiKey) return NextResponse.json({ error: "Missing IX credentials" }, { status: 400 });

            // Advanced Sanitization: Extract slug if user pasted full URL
            if (account.includes("invoicexpress.com")) {
                try {
                    const url = new URL(account.startsWith("http") ? account : `https://${account}`);
                    account = url.hostname.split('.')[0];
                } catch {
                    account = account.split('.')[0];
                }
            }

            const suffix = environment === "macewindu" ? ".macewindu.invoicexpress.com" : ".invoicexpress.com";
            const domain = account.includes('.') ? account : `${account}${suffix}`;

            try {
                // Check if account is valid by listing clients (lightweight check)
                // Pass apiKey both in Header and URL for maximum compatibility
                const res = await fetch(`https://${domain}/clients.json?per_page=1&api_key=${apiKey}`, {
                    headers: {
                        "X-InvoiceXpress-API-Key": apiKey,
                        "Accept": "application/json"
                    }
                });

                if (res.status === 200) {
                    isValid = true;
                } else if (res.status === 530) {
                    errorMessage = `Error 530: Site Not Found. Verifique se escolheu o ambiente correto (Production vs macewindu) para a conta [${account}].`;
                } else {
                    const text = await res.text();
                    try {
                        const data = JSON.parse(text);
                        errorMessage = data.errors || `Error ${res.status}. Check API Key and Account (Slug).`;
                    } catch {
                        errorMessage = `Error ${res.status}. Check Slug [${account}] and API Key.`;
                    }
                }
            } catch (e: any) {
                errorMessage = `Falha na Rede: O domínio [${domain}] não responde.`;
                isValid = false;
            }

            await db.prepare("UPDATE integrations SET ix_authorized = ?, ix_error = ? WHERE user_id = ?")
                .bind(isValid ? 1 : 0, errorMessage || null, targetUserId).run();
        }

        return NextResponse.json({ success: true, isValid, error: errorMessage });

    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
