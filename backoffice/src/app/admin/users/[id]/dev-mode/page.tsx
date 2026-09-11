export const runtime = "edge";
export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { getDevModeTarget } from "@/lib/admin";
import { DevModePanel } from "@/components/admin/DevModePanel";

// No role check here: app/admin/layout.tsx gates the whole tree.
export default async function AdminDevModePage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const target = await getDevModeTarget(id);
    if (!target) notFound();

    return <DevModePanel target={target} />;
}
