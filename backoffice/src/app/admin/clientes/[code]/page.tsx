export const runtime = "edge";
export const dynamic = "force-dynamic";

import { notFound, redirect } from "next/navigation";
import { getRequestContext } from "@cloudflare/next-on-pages";

import { resolveClientCode, ensureClientCode, lookupRetiredCode, normalizeClientCode } from "@/lib/client-code";
import { CustomerRecordPanel } from "@/components/admin/CustomerRecordPanel";

/**
 * One customer's record, addressed by their number.
 *
 * No role check here: app/admin/layout.tsx gates the whole tree, and the API
 * this page's panel calls checks again on its own.
 *
 * A Clerk id is accepted and redirected to the canonical code URL, so every
 * link that already points at /admin/users/<id>/dev-mode converts by changing
 * the path alone — and so an operator holding a raw id from a log line can open
 * the record with it.
 */
export default async function AdminClientRecordPage({ params }: { params: Promise<{ code: string }> }) {
    const { code } = await params;

    const db = (() => {
        try { return (getRequestContext().env as any)?.DB ?? null; } catch { return null; }
    })();

    // No binding (a local `next dev` without D1): let the panel render and report
    // the failure itself rather than 404-ing a page that is fine.
    if (!db) return <CustomerRecordPanel code={code} />;

    const resolved = await resolveClientCode(db, code);
    if (!resolved) {
        // A retired number is not a typo, and the panel says which it is.
        const retired = await lookupRetiredCode(db, code);
        if (retired) return <CustomerRecordPanel code={code} />;
        notFound();
    }

    const canonical = await ensureClientCode(db, resolved.accountId);
    if (canonical && normalizeClientCode(code) !== canonical) {
        redirect(`/admin/clientes/${canonical}`);
    }

    return <CustomerRecordPanel code={canonical ?? code} />;
}
