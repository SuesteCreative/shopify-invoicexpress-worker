import { auth } from "@clerk/nextjs/server";
import { isAdmin } from "@/lib/admin";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { redirect, notFound } from "next/navigation";
import { DevModePanel } from "./DevModePanel";

export const runtime = "edge";
export const dynamic = "force-dynamic";

export default async function DevModePage({ params }: { params: Promise<{ id: string }> }) {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        redirect("/dashboard");
    }

    const { id } = await params;
    const { env } = getRequestContext();
    const db = (env as any).DB;

    const target: any = await db.prepare(`
      SELECT u.id, u.name, u.email, u.role, u.nif, u.company_name,
             i.shopify_domain, i.shopify_authorized, i.ix_authorized,
             i.shopify_error, i.ix_error, i.dev_notify_emails
      FROM users u
      LEFT JOIN integrations i ON u.id = i.user_id
      WHERE u.id = ?
    `).bind(id).first();

    if (!target) notFound();

    return (
        <DevModePanel
            target={{
                id: target.id,
                name: target.name,
                email: target.email,
                role: target.role,
                nif: target.nif,
                company_name: target.company_name,
                shopify_domain: target.shopify_domain,
                shopify_authorized: !!target.shopify_authorized,
                ix_authorized: !!target.ix_authorized,
                shopify_error: target.shopify_error,
                ix_error: target.ix_error,
            }}
        />
    );
}
