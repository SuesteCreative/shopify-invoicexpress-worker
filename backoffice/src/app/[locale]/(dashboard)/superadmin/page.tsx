export const runtime = "edge";
export const dynamic = "force-dynamic";

import { SuperadminPanel } from "@/components/admin/SuperadminPanel";

// The role gate lives in the sibling layout.tsx, which covers this page and
// every sub-route. The panel itself now lives in components/admin so that the
// new /admin surface can render the same component without a second copy.
export default function SuperadminPage() {
    return <SuperadminPanel />;
}
