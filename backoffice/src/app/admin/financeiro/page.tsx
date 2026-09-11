export const runtime = "edge";
export const dynamic = "force-dynamic";

import { FinancePanel } from "@/components/admin/FinancePanel";

// No role check here: app/admin/layout.tsx gates the whole tree.
export default function AdminFinancePage() {
    return <FinancePanel />;
}
