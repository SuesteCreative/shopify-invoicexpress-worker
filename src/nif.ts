export function extractAndValidateNIF(order: any): string | null {
    const candidates: string[] = [];

    // 1. Extract from note
    if (order.note) {
        const noteMatches = order.note.match(/\b\d{9}\b/g);
        if (noteMatches) candidates.push(...noteMatches);
    }

    // 2. Extract from note_attributes
    if (order.note_attributes) {
        for (const attr of order.note_attributes) {
            if (attr.value) {
                const attrMatches = String(attr.value).match(/\b\d{9}\b/g);
                if (attrMatches) candidates.push(...attrMatches);
            }
        }
    }

    // 3. Extract from address line 2 (billing and shipping)
    const addresses = [order.billing_address, order.shipping_address];
    for (const addr of addresses) {
        if (addr?.address2) {
            const addrMatches = String(addr.address2).match(/\b\d{9}\b/g);
            if (addrMatches) candidates.push(...addrMatches);
        }
    }

    // Validate candidates
    for (const nif of candidates) {
        if (validatePTNIF(nif)) return nif;
    }

    return null;
}

function validatePTNIF(nif: string): boolean {
    if (!/^\d{9}$/.test(nif)) return false;

    const firstDigit = parseInt(nif[0]);
    if (![1, 2, 3, 5, 6, 8, 9].includes(firstDigit)) return false;

    let sum = 0;
    for (let i = 0; i < 8; i++) {
        sum += parseInt(nif[i]) * (9 - i);
    }

    const remainder = sum % 11;
    const checkDigit = remainder < 2 ? 0 : 11 - remainder;

    return checkDigit === parseInt(nif[8]);
}
