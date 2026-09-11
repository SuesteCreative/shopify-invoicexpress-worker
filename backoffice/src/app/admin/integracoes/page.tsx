export const runtime = "edge";
export const dynamic = "force-dynamic";

import { IntegrationsPanel } from "@/components/admin/IntegrationsPanel";

// No role check here: app/admin/layout.tsx gates the whole tree.
export default function AdminIntegrationsPage() {
    return <IntegrationsPanel />;
}
