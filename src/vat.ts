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

    // 1. Keywords (Priority for specific Portuguese tax rules)
    if (content.includes('workshop')) {
        return 0; // Workshops are typically exempt (Isento)
    }
    if (content.includes('book') || content.includes('livro')) {
        return 6; // Reduced VAT for books
    }

    // 2. Explicitly non-taxable in Shopify
    if (item.taxable === false) {
        return 0;
    }

    // 3. Shopify Tax Lines
    if (item.tax_lines && item.tax_lines.length > 0) {
        const rate = item.tax_lines[0].rate;
        if (Math.abs(rate - 0.06) < 0.001) return 6;
        if (Math.abs(rate - 0.23) < 0.001) return 23;
        if (rate === 0) return 0;
    }

    // 3. Fallback: Assume 0% (Isento) as per user request for unknown items
    return 0;
}
