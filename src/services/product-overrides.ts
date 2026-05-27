import type { Env } from "../env";
import type { SourceKind, DestinationKind } from "../storage";

export interface ProductOverride {
    tax_rate?: number;
    vat_inclusion?: "inc" | "exc";
    exemption_reason?: string;
    name_override?: string;
}

/**
 * Pre-fetch per-SKU overrides keyed by source_reference. Returned as a Map
 * so the destination adapter / IxBuilder can do O(1) lookups while walking
 * the order lines.
 *
 * source_reference shape mirrors MoloniDestination.deriveProductReference:
 *   - Shopify variant SKU (verbatim, capped at 30 chars)
 *   - RIOKO-VARIANT-<id> / RIOKO-PRODUCT-<id> / RIOKO-SHIPPING fallbacks
 *   - Stripe price.id when source=stripe
 */
export async function loadProductOverrides(
    env: Env,
    userId: string,
    sourceKind: SourceKind,
    destinationKind: DestinationKind,
): Promise<Map<string, ProductOverride>> {
    const db = (env as any).DB;
    if (!db) return new Map();

    try {
        const result = await db.prepare(
            `SELECT source_reference, tax_rate, vat_inclusion, exemption_reason, name_override
             FROM product_overrides
             WHERE user_id = ? AND source_kind = ? AND destination_kind = ?`,
        ).bind(userId, sourceKind, destinationKind).all();

        const map = new Map<string, ProductOverride>();
        for (const row of (result.results ?? []) as Array<{
            source_reference: string;
            tax_rate: number | null;
            vat_inclusion: string | null;
            exemption_reason: string | null;
            name_override: string | null;
        }>) {
            const override: ProductOverride = {};
            if (row.tax_rate != null && Number.isFinite(row.tax_rate)) override.tax_rate = Number(row.tax_rate);
            if (row.vat_inclusion === "inc" || row.vat_inclusion === "exc") override.vat_inclusion = row.vat_inclusion;
            if (row.exemption_reason) override.exemption_reason = row.exemption_reason;
            if (row.name_override) override.name_override = row.name_override;
            // Only include rows that actually carry at least one override.
            if (Object.keys(override).length > 0) {
                map.set(row.source_reference, override);
            }
        }
        return map;
    } catch (err) {
        console.warn("[product-overrides] loadProductOverrides failed:", err);
        return new Map();
    }
}
