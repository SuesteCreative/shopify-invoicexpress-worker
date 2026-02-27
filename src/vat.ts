export interface LineItem {
    title: string;
    product_type?: string;
    tax_lines?: Array<{ rate: number }>;
    vendor?: string;
    tags?: string;
}

export function determineVATRate(item: LineItem): number {
    // 1. Check Shopify tax lines
    if (item.tax_lines && item.tax_lines.length > 0) {
        const rate = item.tax_lines[0].rate;
        // Map shopify rate (decimal) to percentage
        if (Math.abs(rate - 0.06) < 0.001) return 6;
        if (Math.abs(rate - 0.23) < 0.001) return 23;
    }

    // 2. Fallback to product keywords
    const content = `${item.title} ${item.product_type || ''} ${item.vendor || ''} ${item.tags || ''}`.toLowerCase();

    if (content.includes('book') || content.includes('livro')) {
        return 6;
    }

    return 23;
}
