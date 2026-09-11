import { auth } from "@clerk/nextjs/server";
import { isAdmin, getDevModeTarget } from "@/lib/admin";
import { redirect, notFound } from "next/navigation";
import { DevModePanel } from "@/components/admin/DevModePanel";

export const runtime = "edge";
export const dynamic = "force-dynamic";

export default async function DevModePage({ params }: { params: Promise<{ id: string }> }) {
    const { userId } = await auth();
    if (!userId || !(await isAdmin(userId))) {
        redirect("/dashboard");
    }

    const { id } = await params;
    const target = await getDevModeTarget(id);
    if (!target) notFound();

    return <DevModePanel target={target} />;
}
