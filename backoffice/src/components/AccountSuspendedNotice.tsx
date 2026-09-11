"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import SuspendedBanner from "@/components/SuspendedBanner";

/**
 * Account-wide "we are not issuing invoices" warning, rendered once by the
 * dashboard layout so it reaches every page.
 *
 * It used to be pasted inside the subscribe block of individual integration
 * pages, which meant a blocked merchant on shopify-ix or stripe-ix — the two
 * busiest integrations — saw nothing at all and only found out when the
 * invoices stopped arriving. Living in the layout, the warning cannot be
 * missed by adding a page.
 *
 * /faturacao keeps its own copy: it has the grace-period variant and the
 * subscribe cards right below it, so a second banner there is just noise.
 */
export default function AccountSuspendedNotice() {
    const pathname = usePathname();
    const [blocked, setBlocked] = useState(false);

    useEffect(() => {
        fetch("/api/billing/subscription")
            .then(r => r.json())
            .then((d: any) => setBlocked(!!d?.blocked))
            .catch(() => setBlocked(false));
    }, []);

    if (!blocked || pathname.endsWith("/faturacao")) return null;

    return (
        <div className="mb-8">
            <SuspendedBanner />
        </div>
    );
}
