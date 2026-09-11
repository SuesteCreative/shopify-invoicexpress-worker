/**
 * What a merchant typed into "InvoiceXpress account name", reduced to the
 * account subdomain.
 *
 * They paste the whole address at least as often as they type the name, and the
 * onboarding page has to do two things with the answer: build the link to their
 * own InvoiceXpress, and save the name the worker will call. `/api/integrations/
 * validate` already sanitises the same way before it asks InvoiceXpress, so what
 * is stored and what is verified have to agree.
 */
export function ixSubdomain(raw: string): string {
    const host = raw.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    return host
        .replace(/\.app\.invoicexpress\.com$/i, "")
        .replace(/\.macewindu\.invoicexpress\.com$/i, "")
        .replace(/\.invoicexpress\.com$/i, "")
        .toLowerCase();
}
