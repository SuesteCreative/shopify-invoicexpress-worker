export function extractAndValidateNIF(order: any): string | null {
    const candidates: string[] = [];

    // 1. Extract from note_attributes (Dedicated NIF/VAT fields from Shopify apps)
    if (order.note_attributes) {
        for (const attr of order.note_attributes) {
            const name = String(attr.name).toLowerCase();
            if (["nif", "vat", "contribuinte", "fiscal", "tax id"].includes(name) && attr.value) {
                const clean = String(attr.value).replace(/\D/g, "");
                if (clean.length >= 9) candidates.push(clean.slice(-9));
            }
        }
    }

    // 2. Extract from Customer Note
    if (order.customer?.note) {
        const matches = order.customer.note.match(/\b\d{9}\b/g);
        if (matches) candidates.push(...matches);
    }

    // 3. Extract from Customer Tags
    if (order.customer?.tags) {
        const matches = order.customer.tags.match(/\b\d{9}\b/g);
        if (matches) candidates.push(...matches);
    }

    // 4. Extract from General Order Note
    if (order.note) {
        const matches = order.note.match(/\b\d{9}\b/g);
        if (matches) candidates.push(...matches);
    }

    // 5. Extract from Billing Address fields (Company, Address2)
    const billing = order.billing_address;
    if (billing) {
        if (billing.company) {
            const matches = billing.company.match(/\b\d{9}\b/g);
            if (matches) candidates.push(...matches);
        }
        if (billing.address2) {
            const matches = billing.address2.match(/\b\d{9}\b/g);
            if (matches) candidates.push(...matches);
        }
    }

    // 6. Validate candidates for Portuguese algorithm
    for (const nif of candidates) {
        if (validatePTNIF(nif)) return nif;
    }

    // 7. If no algorithm match, pick the first 9-digit candidate if any (for international or just in case)
    if (candidates.length > 0) return candidates[0];

    return null;
}

export function validatePTNIF(nif: string): boolean {
    if (!/^\d{9}$/.test(nif)) return false;

    const firstDigit = parseInt(nif[0]);
    if (![1, 2, 3, 4, 5, 6, 7, 8, 9].includes(firstDigit)) return false;

    let sum = 0;
    for (let i = 0; i < 8; i++) {
        sum += parseInt(nif[i]) * (9 - i);
    }

    const remainder = sum % 11;
    const checkDigit = remainder < 2 ? 0 : 11 - remainder;

    return checkDigit === parseInt(nif[8]);
}
