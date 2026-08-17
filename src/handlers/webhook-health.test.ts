import { describe, it, expect } from "vitest";
import {
  diffShopifyWebhooks,
  classifyListResponse,
  isRegistrationSuccess,
  REQUIRED_WEBHOOKS,
} from "./webhook-health";

/**
 * The check exists because a shop with no webhooks is indistinguishable from a
 * shop with no sales, so the comparison had better be exact. Two ways to get it
 * wrong, both worse than not checking at all: call a present hook missing and
 * re-register on every run, or call a hook that points at an old deployment
 * present and keep believing a silent shop is healthy.
 */

const WORKER = "https://shopify-invoicexpress-worker.pedrotovarporto.workers.dev";

const allHooks = (base = WORKER) => REQUIRED_WEBHOOKS.map((r) => ({
  topic: r.topic, address: `${base}${r.path}`,
}));

describe("diffShopifyWebhooks", () => {
  it("finds nothing missing when all four point at us", () => {
    expect(diffShopifyWebhooks(allHooks(), WORKER)).toEqual([]);
  });

  it("names exactly the topic that is gone", () => {
    const hooks = allHooks().filter((h) => h.topic !== "refunds/create");
    expect(diffShopifyWebhooks(hooks, WORKER)).toEqual(["refunds/create"]);
  });

  it("counts a hook aimed at an old deployment as missing", () => {
    // Present in the Shopify admin, delivering to nobody — the failure mode a
    // topic-only comparison would call healthy.
    const hooks = allHooks("https://old-worker.example.workers.dev");
    expect(diffShopifyWebhooks(hooks, WORKER)).toEqual(REQUIRED_WEBHOOKS.map((r) => r.topic));
  });

  it("ignores unrelated hooks the merchant set up themselves", () => {
    const hooks = [
      ...allHooks(),
      { topic: "products/update", address: "https://some-other-app.example.com/hook" },
      { topic: "orders/create", address: "https://analytics.example.com/hook" },
    ];
    expect(diffShopifyWebhooks(hooks, WORKER)).toEqual([]);
  });

  it("tolerates a trailing slash on the configured worker URL", () => {
    expect(diffShopifyWebhooks(allHooks(), `${WORKER}/`)).toEqual([]);
  });

  it("reports everything missing on an empty or malformed list", () => {
    const all = REQUIRED_WEBHOOKS.map((r) => r.topic);
    expect(diffShopifyWebhooks([], WORKER)).toEqual(all);
    expect(diffShopifyWebhooks(undefined as any, WORKER)).toEqual(all);
    expect(diffShopifyWebhooks([{}, { topic: "orders/create" }], WORKER)).toEqual(all);
  });

  it("covers the four topics the pipeline actually needs", () => {
    // orders/create builds the document; the others finalize, re-sync and
    // credit it. Losing any one breaks a different half of the flow.
    expect(REQUIRED_WEBHOOKS.map((r) => r.topic).sort()).toEqual([
      "orders/create", "orders/paid", "orders/updated", "refunds/create",
    ]);
  });
});

describe("classifyListResponse", () => {
  it("separates the three ways a shop can refuse to answer", () => {
    expect(classifyListResponse(200)).toBe("ok");
    // A dead token: nothing arrives and nothing can be repaired.
    expect(classifyListResponse(401)).toBe("auth_failed");
    // A live token without read_webhooks: the check cannot see, which is NOT
    // evidence the hooks are gone — hence its own outcome.
    expect(classifyListResponse(403)).toBe("no_scope");
    expect(classifyListResponse(500)).toBe("unreachable");
    expect(classifyListResponse(429)).toBe("unreachable");
  });
});

describe("isRegistrationSuccess", () => {
  it("accepts a fresh registration", () => {
    expect(isRegistrationSuccess(201, "{}")).toBe(true);
  });

  it("accepts Shopify's way of saying it already exists", () => {
    // A 422 for a hook that raced in between listing and registering is a
    // success, not a failure to alert on.
    expect(isRegistrationSuccess(422, '{"errors":{"address":["has already been taken"]}}')).toBe(true);
  });

  it("does not accept any other 422", () => {
    expect(isRegistrationSuccess(422, '{"errors":{"topic":["is invalid"]}}')).toBe(false);
  });

  it("does not accept a refusal", () => {
    expect(isRegistrationSuccess(401, "")).toBe(false);
    expect(isRegistrationSuccess(403, "")).toBe(false);
    expect(isRegistrationSuccess(500, "")).toBe(false);
  });
});
