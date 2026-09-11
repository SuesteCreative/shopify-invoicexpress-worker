export const runtime = "edge";
export const dynamic = "force-dynamic";

import { SuperadminPanel } from "@/components/admin/SuperadminPanel";

// No role check here: app/admin/layout.tsx gates the whole tree.
export default function AdminHomePage() {
    return <SuperadminPanel />;
}
