export const runtime = "edge";
export const dynamic = "force-dynamic";

import { StatsPanel } from "@/components/admin/StatsPanel";

// No role check here: app/admin/layout.tsx gates the whole tree.
export default function AdminHomePage() {
    return <StatsPanel />;
}
