export interface LineItem {
    title: string;
    product_type?: string;
    tax_lines?: Array<{ rate: number }>;
    vendor?: string;
    tags?: string;
    taxable?: boolean;
}

export function determineVATRate(item: LineItem): number {
    const content = `${item.title} ${item.product_type || ''} ${item.vendor || ''} ${item.tags || ''}`.toLowerCase();

    // 1. High-Priority Override: Workshops (usually 0% regardless of Shopify settings)
    if (content.includes('workshop')) {
        return 0;
    }

    // 2. Primary Source: Shopify Tax Lines (Explicitly set on the product/order)
    if (item.tax_lines && item.tax_lines.length > 0) {
        const rate = item.tax_lines[0].rate;
        if (Math.abs(rate - 0.06) < 0.001) return 6;
        if (Math.abs(rate - 0.23) < 0.001) return 23;
        if (rate === 0) return 0;
    }

    // 3. Explicitly non-taxable in Shopify
    if (item.taxable === false) {
        return 0;
    }

    // 4. Fallback Keyword Detection (Only if Shopify has no tax info listed)
    if (content.includes('book') || content.includes('livro')) {
        return 6;
    }

    // 5. Global Fallback
    return 0;
}
