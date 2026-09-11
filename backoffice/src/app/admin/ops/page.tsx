export const runtime = "edge";
export const dynamic = "force-dynamic";

import { OpsPanel } from "@/components/admin/OpsPanel";

// No role check here: app/admin/layout.tsx gates the whole tree.
export default function AdminOpsPage() {
    return <OpsPanel />;
}
