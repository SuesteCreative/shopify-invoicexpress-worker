import type { MetadataRoute } from "next";

export const runtime = "edge";

export default function robots(): MetadataRoute.Robots {
    return {
        rules: [
            {
                userAgent: "*",
                allow: "/",
                disallow: [
                    "/api/",
                    "/sign-in",
                    "/sign-up",
                    "/dashboard",
                    "/integrations",
                    "/conciliacao",
                    "/faturacao",
                    "/help",
                    "/superadmin",
                    "/client-rules",
                    "/invoices",
                ],
            },
        ],
        sitemap: "https://rioko.online/sitemap.xml",
        host: "https://rioko.online",
    };
}
