import { describe, it, expect } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
    MERCHANT_ROUTE_SLUGS, merchantRouteSlug, merchantIntegrationHref,
} from "./merchant-routes";

/**
 * The admin console's impersonate button sets the cookie and then navigates, so
 * a wrong slug drops an operator on a 404 while already wearing somebody else's
 * session. The list of valid slugs is therefore checked against the directories
 * that actually exist, rather than trusted.
 */

const INTEGRATIONS_DIR = join(
    process.cwd(),
    "backoffice/src/app/[locale]/(dashboard)/integrations",
);

/** Pages under integrations/ that configure a pipe. The rest are tools. */
const NOT_A_PIPE = new Set(["ix-overrides", "moloni-mappings", "tag-routing"]);

describe("the slug for a pair", () => {
    it("kebab-cases the source and shortens InvoiceXpress", () => {
        expect(merchantRouteSlug("stripe_connect", "invoicexpress")).toBe("stripe-connect-ix");
        expect(merchantRouteSlug("shopify", "invoicexpress")).toBe("shopify-ix");
        expect(merchantRouteSlug("lodgify", "moloni")).toBe("lodgify-moloni");
    });

    it("locale-prefixes the path, because the merchant app does live under one", () => {
        expect(merchantIntegrationHref("stripe", "moloni")).toBe("/pt/integrations/stripe-moloni");
        expect(merchantIntegrationHref("stripe", "moloni", "en")).toBe("/en/integrations/stripe-moloni");
    });

    it("falls back to the index for a pair with no configurator", () => {
        // A valid connection the database accepts, with no page behind it.
        expect(merchantIntegrationHref("eupago", "moloni")).toBe("/pt/integrations");
    });
});

describe("the slug list matches what is on disk", () => {
    // Skipped rather than failed when run from somewhere the tree is not
    // visible: a path assumption must not turn into a red suite.
    const canSee = existsSync(INTEGRATIONS_DIR);

    it.skipIf(!canSee)("names every configurator page, and nothing that is not one", () => {
        const onDisk = readdirSync(INTEGRATIONS_DIR, { withFileTypes: true })
            .filter((e) => e.isDirectory() && !NOT_A_PIPE.has(e.name))
            .map((e) => e.name)
            .sort();

        expect([...MERCHANT_ROUTE_SLUGS].sort()).toEqual(onDisk);
    });
});
