export const runtime = "edge";
export const dynamic = "force-dynamic";

import { OnboardingHelperPanel } from "@/components/admin/OnboardingHelperPanel";

// No role check here: app/admin/layout.tsx gates the whole tree.
export default function AdminOnboardingHelperPage() {
    return <OnboardingHelperPanel />;
}
