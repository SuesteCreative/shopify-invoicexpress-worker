import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isHiperadmin } from "@/lib/admin";
import { getStripe } from "@/lib/stripe";
import { buildPriceBook } from "@/lib/price-book";
import {
    requiredPrices, statusOf, PRODUCT_TAX_CODE, PRODUCT_IMAGE_URL,
    SEAT_PRICE_LOOKUP, SEAT_PRICE_CENTS, type RequiredPrice,
} from "@/lib/price-catalogue";

export const runtime = "edge";

/**
 * Make Stripe match the catalogue: create the prices that are missing, replace
 * the ones sitting at the wrong amount, and fill in what a Rioko product is
 * supposed to carry.
 *
 * A pair with no price is configurable right up to the card form and then 500s
 * at the moment the merchant tries to pay. A pair at the WRONG price is worse,
 * because it does not fail at all: `stripe-ix-*` and `stripe-moloni-*` quietly
 * sold at 5 €/50 € for months. Doing this by hand means remembering the lookup
 * key exactly, and a typo there fails the same way — so every name, amount and
 * label comes from the same map the checkout reads.
 *
 * Hiperadmin, and a dry run unless told otherwise. This writes to Stripe, and a
 * price cannot be deleted once created, only archived.
 */

/** Everything Stripe holds, keyed by id AND lookup key — `price_id` in our own
 *  database is sometimes one and sometimes the other. A key beats an id: see
 *  buildPriceBook, and the reason it matters here is that this endpoint is what
 *  creates the collision when it replaces a price. */
async function priceBook(stripe: any): Promise<Map<string, any>> {
    const all: any[] = [];
    let page = await stripe.prices.list({ limit: 100 });
    all.push(...page.data);
    let guard = 0;
    while (page.has_more && guard++ < 5) {
        page = await stripe.prices.list({ limit: 100, starting_after: page.data.at(-1)?.id });
        all.push(...page.data);
    }
    return buildPriceBook(all);
}

/**
 * What the product should say about itself, for the fields it does not say yet.
 *
 * Only ever fills a blank. A description someone wrote by hand is left alone,
 * and so is an image already uploaded through the dashboard — this exists to
 * close the gaps, not to impose a house style on live products.
 */
function templateGaps(product: any, description: string): Record<string, any> {
    const patch: Record<string, any> = {};
    if (!product.description) patch.description = description;
    if (!product.tax_code) patch.tax_code = PRODUCT_TAX_CODE;
    if (!product.images?.length) patch.images = [PRODUCT_IMAGE_URL];
    if (product.metadata?.app !== "rioko") patch.metadata = { ...(product.metadata ?? {}), app: "rioko" };
    return patch;
}

/** Fill those gaps on a product that already exists. Returns what it filled. */
async function fillProductTemplate(
    stripe: any, productId: string, description: string, dryRun: boolean,
): Promise<string[]> {
    const product = await stripe.products.retrieve(productId).catch(() => null);
    if (!product) return [];
    const patch = templateGaps(product, description);
    const filled = Object.keys(patch);
    if (filled.length && !dryRun) await stripe.products.update(productId, patch);
    return filled;
}

/**
 * The product this price belongs on, carrying the whole template.
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
    const siblingProduct = sibling?.product
        ? (typeof sibling.product === "string" ? sibling.product : sibling.product.id)
        : null;

    let existing: any = null;
    if (siblingProduct) {
        existing = await stripe.products.retrieve(siblingProduct).catch(() => null);
        if (!existing) return { id: siblingProduct, created: false, filled: [] as string[] };
    } else {
        // Then an existing product of the same name, so re-running this does not
        // pile up duplicates.
        try {
            const found = await stripe.products.search({ query: `name:"${req.productName}"`, limit: 1 });
            existing = found.data[0] ?? null;
        } catch {
            // Search is not enabled on every account; falling through to create
            // is safe because the name check is only an optimisation.
        }
    }

    if (existing) {
        return {
            id: existing.id,
            created: false,
            filled: await fillProductTemplate(stripe, existing.id, req.productDescription, dryRun),
        };
    }

    if (dryRun) return { id: null, created: true, filled: ["description", "tax_code", "images", "metadata"] };
    const product = await stripe.products.create({
        name: req.productName,
        description: req.productDescription,
        tax_code: PRODUCT_TAX_CODE,
        images: [PRODUCT_IMAGE_URL],
        // This Stripe account is shared with another billing system. The tag is
        // how an audit tells our catalogue from its ~490 objects.
        metadata: { app: "rioko" },
    });
    return { id: product.id, created: true, filled: ["description", "tax_code", "images", "metadata"] };
}

/** The id of a product's default price, whichever shape Stripe returns it in. */
async function defaultPriceOf(stripe: any, productId: string): Promise<string | null> {
    const product = await stripe.products.retrieve(productId).catch(() => null);
    const d = product?.default_price;
    return typeof d === "string" ? d : d?.id ?? null;
}

/** How many subscriptions a price is carrying, so nobody confirms blind. */
async function subscriberCount(stripe: any, priceId: string): Promise<number | null> {
    try {
        const subs = await stripe.subscriptions.list({ price: priceId, status: "all", limit: 100 });
        return subs.data.length;
    } catch {
        return null;
    }
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
        // A dry run creates nothing, so the second plan of a new pair would
        // report the same product as new all over again. One line per product.
        const productsSeen = new Set<string>();
        for (const req of requiredPrices()) {
            const existing = req.lookup ? book.get(req.lookup) : null;
            const status = statusOf(req, existing);

            // An archived price is a deliberate act and a client may still be on
            // it; un-archiving one silently is not this endpoint's business.
            // But a price can be perfectly right and still sit on a product with
            // no description, no tax code and no image — which is most of them,
            // because the creator only ever set a name. Fill those and move on.
            if (status !== "missing" && status !== "wrong_amount") {
                const pid = typeof existing?.product === "string" ? existing.product : existing?.product?.id;
                if (pid && !productsSeen.has(req.productName)) {
                    productsSeen.add(req.productName);
                    const filled = await fillProductTemplate(stripe, pid, req.productDescription, dryRun).catch(() => []);
                    if (filled.length) {
                        planned.push({
                            action: "product",
                            lookup: req.lookup,
                            product_name: req.productName,
                            product_id: pid,
                            product_filled: filled,
                            amount_cents: req.amountCents,
                            interval: req.interval,
                            created: false,
                        });
                    }
                }
                continue;
            }

            const entry: any = {
                action: status === "missing" ? "create" : "replace",
                lookup: req.lookup,
                product_name: req.productName,
                amount_cents: req.amountCents,
                interval: req.interval,
                created: false,
            };
            if (status === "wrong_amount") {
                entry.replaces_price_id = existing.id;
                entry.replaces_amount_cents = existing.unit_amount;
                entry.replaces_subscriptions = await subscriberCount(stripe, existing.id);
            }

            try {
                const product = await productFor(stripe, req, book, dryRun);
                const firstMention = !productsSeen.has(req.productName);
                productsSeen.add(req.productName);
                entry.product_id = product.id;
                entry.product_created = product.created && firstMention;
                if (product.filled.length && firstMention) entry.product_filled = product.filled;

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
                        nickname: `${req.productName} — ${req.plan}`,
                        metadata: { app: "rioko", pair: req.connectionKey, plan: req.plan },
                        // A lookup key lives on one price at a time. Taking it
                        // from the price being replaced is what makes the swap
                        // atomic; on a create there is nothing to take it from.
                        ...(status === "wrong_amount" ? { transfer_lookup_key: true } : {}),
                    };
                    let price: any;
                    try {
                        // The fleet's older prices carry the lookup key as their
                        // id too. Stripe does not document that on create, so it
                        // is attempted and not depended on — and on a replace the
                        // id is already taken by the price being retired.
                        price = await stripe.prices.create({ ...params, id: req.lookup });
                    } catch {
                        price = await stripe.prices.create(params);
                    }
                    entry.price_id = price.id;
                    entry.created = true;

                    // The retired price keeps billing whoever is already on it;
                    // archiving only stops it being sold again.
                    //
                    // The default price has to move FIRST. Stripe refuses to
                    // archive a price that is still its product's default —
                    // "This price cannot be archived because it is the default
                    // price of its product" — and archiving was the last step,
                    // so the replacement went in, the lookup key moved, and the
                    // old price stayed on sale (12/09/2026).
                    if (status === "wrong_amount") {
                        if (await defaultPriceOf(stripe, product.id) === existing.id) {
                            await stripe.products.update(product.id, { default_price: price.id });
                            entry.default_moved = true;
                        }
                        await stripe.prices.update(existing.id, { active: false });
                        entry.replaced_archived = true;
                        book.delete(existing.id);
                    }

                    book.set(price.id, price);
                    if (price.lookup_key) book.set(price.lookup_key, price);
                }
            } catch (e: any) {
                entry.error = e?.message ?? String(e);
            }

            planned.push(entry);
        }

        // A product still pointing at a price that is not in the catalogue.
        //
        // That is what a replacement leaves behind when the archive step fails:
        // the new price holds the lookup key, the old one keeps selling, and the
        // loop above never comes back — the key resolves correctly now, so the
        // pair reads "ok". Narrow on purpose: only a default that is NOT a
        // catalogue price is moved, and only the price it displaces is archived.
        // A deliberate price someone made in the dashboard keeps its lookup key
        // or is not a default, and is left alone either way.
        const catalogueProducts = new Map<string, { want: any; name: string }>();
        for (const req of requiredPrices()) {
            const p = req.lookup ? book.get(req.lookup) : null;
            const pid = typeof p?.product === "string" ? p.product : p?.product?.id;
            if (!p || !pid) continue;
            const seen = catalogueProducts.get(pid);
            // The monthly price is the one a product defaults to, when it has one.
            if (!seen || req.plan === "monthly") catalogueProducts.set(pid, { want: p, name: req.productName });
        }
        for (const [pid, { want, name }] of catalogueProducts) {
            try {
                const current = await defaultPriceOf(stripe, pid);
                if (!current || current === want.id) continue;
                const displaced = await stripe.prices.retrieve(current).catch(() => null);
                if (!displaced || displaced.lookup_key) continue;

                const subs = await subscriberCount(stripe, displaced.id);
                if (!dryRun) {
                    await stripe.products.update(pid, { default_price: want.id });
                    if (displaced.active) await stripe.prices.update(displaced.id, { active: false });
                }
                planned.push({
                    action: "default",
                    lookup: want.lookup_key ?? want.id,
                    product_name: name,
                    product_id: pid,
                    amount_cents: want.unit_amount,
                    interval: want.recurring?.interval ?? "month",
                    replaces_price_id: displaced.id,
                    replaces_amount_cents: displaced.unit_amount,
                    replaces_subscriptions: subs,
                    replaced_archived: displaced.active,
                    created: false,
                });
            } catch (e: any) {
                planned.push({ action: "default", lookup: name, product_name: name, amount_cents: 0, interval: "month", error: e?.message ?? String(e) });
            }
        }

        // The seat is not a pair, so the loop above never reaches it — and its
        // product was the only one in the catalogue with no image at all. The
        // price itself is never created here: it is one-off, it exists, and
        // what it should cost is a decision, not a gap to fill.
        const seat = book.get(SEAT_PRICE_LOOKUP);
        const seatProductId = typeof seat?.product === "string" ? seat.product : seat?.product?.id;
        if (seatProductId) {
            const filled = await fillProductTemplate(
                stripe, seatProductId, "Um utilizador extra na sua conta Rioko 2.0. || An extra user on your Rioko 2.0 account.", dryRun,
            ).catch(() => []);
            if (filled.length) {
                planned.push({
                    action: "product",
                    lookup: SEAT_PRICE_LOOKUP,
                    product_name: "Rioko 2.0 || Extra User",
                    product_id: seatProductId,
                    product_filled: filled,
                    amount_cents: SEAT_PRICE_CENTS,
                    interval: "one_time",
                    created: false,
                });
            }
        }

        console.warn(`[admin/finance/prices] ${dryRun ? "dry run" : "applied"} ${planned.length} by ${userId}`);
        return NextResponse.json({ dry_run: dryRun, prices: planned });
    } catch (error: any) {
        console.error("[admin/finance/prices] failed:", error?.message ?? error);
        return NextResponse.json({ error: "price_create_failed" }, { status: 500 });
    }
}
