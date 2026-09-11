import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isHiperadmin } from "@/lib/admin";
import { getStripe } from "@/lib/stripe";
import { requiredPrices, statusOf, type RequiredPrice } from "@/lib/price-catalogue";

export const runtime = "edge";

/**
 * Create the prices the checkout needs and Stripe does not have.
 *
 * A pair with no price is configurable right up to the card form and then 500s
 * at the moment the merchant tries to pay. Creating them by hand means
 * remembering the lookup key exactly, and a typo there fails the same way — so
 * the names come from the same map the checkout reads.
 *
 * Hiperadmin, and a dry run unless told otherwise. This writes to Stripe, and a
 * price cannot be deleted once created, only archived.
 */

/** Everything Stripe holds, keyed by id AND lookup key — `price_id` in our own
 *  database is sometimes one and sometimes the other. */
async function priceBook(stripe: any): Promise<Map<string, any>> {
    const book = new Map<string, any>();
    let page = await stripe.prices.list({ limit: 100 });
    const add = (p: any) => {
        book.set(p.id, p);
        if (p.lookup_key) book.set(p.lookup_key, p);
    };
    page.data.forEach(add);
    let guard = 0;
    while (page.has_more && guard++ < 5) {
        page = await stripe.prices.list({ limit: 100, starting_after: page.data.at(-1)?.id });
        page.data.forEach(add);
    }
    return book;
}

/**
 * The product this price belongs on.
 *
 * The sibling plan first: monthly and annual of the same pair are two prices on
 * ONE product, and creating a second product for the other interval is how a
 * client ends up with two differently-named lines for the same thing. Only when
 * neither interval exists is a product created.
 */
async function productFor(stripe: any, req: RequiredPrice, book: Map<string, any>, dryRun: boolean) {
    const siblingLookup = req.plan === "annual"
        ? req.lookup?.replace(/-yearly$/, "-monthly")
        : req.lookup?.replace(/-monthly$/, "-yearly");
    const sibling = siblingLookup ? book.get(siblingLookup) : null;
    if (sibling?.product) {
        return { id: typeof sibling.product === "string" ? sibling.product : sibling.product.id, created: false };
    }

    // Then an existing product of the same name, so re-running this does not
    // pile up duplicates.
    try {
        const found = await stripe.products.search({ query: `name:"${req.productName}"`, limit: 1 });
        if (found.data[0]) return { id: found.data[0].id, created: false };
    } catch {
        // Search is not enabled on every account; falling through to create is
        // safe because the name check above is only an optimisation.
    }

    if (dryRun) return { id: null, created: true };
    const product = await stripe.products.create({ name: req.productName });
    return { id: product.id, created: true };
}

export async function POST(request: NextRequest) {
    try {
        const { userId } = await auth();
        // Creating something that charges money is hiperadmin work.
        if (!userId || !(await isHiperadmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await request.json().catch(() => ({})) as { confirm?: boolean };
        const dryRun = body.confirm !== true;

        const stripe = getStripe();
        const book = await priceBook(stripe);

        const planned: any[] = [];
        for (const req of requiredPrices()) {
            const existing = req.lookup ? book.get(req.lookup) : null;
            const status = statusOf(req, existing);
            // Only what is genuinely absent. An archived price is a deliberate
            // act and a client may still be on it; replacing one silently is
            // not this endpoint's business.
            if (status !== "missing") continue;

            const entry: any = {
                lookup: req.lookup,
                product_name: req.productName,
                amount_cents: req.amountCents,
                interval: req.interval,
                created: false,
            };

            try {
                const product = await productFor(stripe, req, book, dryRun);
                entry.product_id = product.id;
                entry.product_created = product.created;

                if (!dryRun && product.id) {
                    const params: any = {
                        product: product.id,
                        currency: "eur",
                        unit_amount: req.amountCents,
                        recurring: { interval: req.interval },
                        lookup_key: req.lookup,
                        // The checkout attaches the tax rate itself, so the price
                        // is the amount before IVA.
                        tax_behavior: "exclusive",
                    };
                    let price: any;
                    try {
                        // The fleet's older prices carry the lookup key as their
                        // id too. Stripe does not document that on create, so it
                        // is attempted and not depended on.
                        price = await stripe.prices.create({ ...params, id: req.lookup });
                    } catch {
                        price = await stripe.prices.create(params);
                    }
                    entry.price_id = price.id;
                    entry.created = true;
                    book.set(price.id, price);
                    if (price.lookup_key) book.set(price.lookup_key, price);
                }
            } catch (e: any) {
                entry.error = e?.message ?? String(e);
            }

            planned.push(entry);
        }

        console.warn(`[admin/finance/prices] ${dryRun ? "dry run" : "created"} ${planned.length} by ${userId}`);
        return NextResponse.json({ dry_run: dryRun, prices: planned });
    } catch (error: any) {
        console.error("[admin/finance/prices] failed:", error?.message ?? error);
        return NextResponse.json({ error: "price_create_failed" }, { status: 500 });
    }
}
