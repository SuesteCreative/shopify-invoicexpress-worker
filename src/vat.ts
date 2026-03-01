export interface LineItem {
    title: string;
    product_type?: string;
    tax_lines?: Array<{ rate: number }>;
    vendor?: string;
    tags?: string;
    taxable?: boolean;
}

export function determineVATRate(item: LineItem): number {
    // 1. Primary Source: Shopify Tax Lines (Decimal to Percentage)
    if (item.tax_lines && item.tax_lines.length > 0) {
        const rate = item.tax_lines[0].rate;
        return Math.round(rate * 100); // e.g., 0.23 -> 23
    }

    // 2. Explicitly non-taxable in Shopify
    if (item.taxable === false) {
        return 0;
    }

    // 3. Global Fallback (Exempt)
    // As per user request: "se o produto não tem informação de iva aplica isento"
    return 0;
}
