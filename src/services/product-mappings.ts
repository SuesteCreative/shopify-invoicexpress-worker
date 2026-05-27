import type { Env } from "../env";
import type { SourceKind } from "../storage";

/**
 * Pre-fetch the user's explicit Stripe/Shopify → Moloni product mappings
 * before the destination adapter runs. The Moloni adapter checks this Map
 * before falling back to its find-or-create-by-reference flow.
 *
 * Keyed by `source_reference` (the same string MoloniDestination's
 * `deriveProductReference()` produces for a normalized item). Value is the
 * Moloni `product_id` chosen by the merchant in /integrations/moloni-mappings.
 */
export async function loadProductMappings(
    env: Env,
    userId: string,
    sourceKind: SourceKind,
): Promise<Map<string, number>> {
    const db = (env as any).DB;
    if (!db) return new Map();

    try {
        const result = await db.prepare(
            `SELECT source_reference, destination_product_id
             FROM product_mappings
             WHERE user_id = ? AND source_kind = ? AND destination_kind = 'moloni'`,
        ).bind(userId, sourceKind).all();

        const map = new Map<string, number>();
        for (const row of (result.results ?? []) as Array<{ source_reference: string; destination_product_id: number }>) {
            const pid = Number(row.destination_product_id);
            if (row.source_reference && Number.isFinite(pid) && pid > 0) {
                map.set(row.source_reference, pid);
            }
        }
        return map;
    } catch (err) {
        // Don't block the pipeline if the mappings table is missing or transient
        // D1 error — just fall back to the adapter's auto-create path.
        console.warn("[product-mappings] loadProductMappings failed:", err);
        return new Map();
    }
}
