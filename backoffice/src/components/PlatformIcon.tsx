import { ClipboardList, CreditCard, Landmark, Store, Wallet } from "lucide-react";
import type { PlatformIconName } from "@/lib/platforms";

/**
 * Renders the fallback icon for a platform that has no logo.
 *
 * The catalogue in `@/lib/platforms` names the icon instead of importing it, so
 * that a plain data module stays free of `lucide-react`. This is where the name
 * becomes a component, and it lives under components/ so nothing in lib/ pulls
 * a UI package into the root test run.
 */
const ICONS = {
    store: Store,
    card: CreditCard,
    wallet: Wallet,
    bank: Landmark,
    clipboard: ClipboardList,
} as const;

export default function PlatformIcon(
    { name, ...props }: { name: PlatformIconName } & React.ComponentProps<typeof Store>,
) {
    const Icon = ICONS[name];
    return <Icon {...props} />;
}
