export const runtime = "edge";
export const dynamic = "force-dynamic";

import AccountPanel from "@/components/AccountPanel";

/**
 * The merchant's own account: their customer number, what they may correct
 * themselves, and how to ask for the two fields they may not.
 *
 * A thin wrapper, like every other page in this group — the layout above
 * already carries the sidebar, the suspended-account notice and the setup modal.
 */
export default function ContaPage() {
    return <AccountPanel />;
}
