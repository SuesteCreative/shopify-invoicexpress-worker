import { describe, it, expect } from "vitest";
import {
  normalizeRule,
  parseStoredRoute,
  applyTagRoute,
  matchTagRouting,
  type TagRoutingRule,
} from "./tag-routing";
import type { AdapterCtx } from "../adapters/types";

const rule = (over: Partial<TagRoutingRule> = {}): TagRoutingRule => ({
  tag_name: "channel:retail",
  document_type: null,
  series_name: null,
  finalize_mode: null,
  ...over,
});

const order = (over: Record<string, any> = {}) => ({
  tags: [],
  note_attributes: [],
  ...over,
}) as any;

const ctx = (over: Partial<AdapterCtx> = {}): AdapterCtx => ({
  apiKey: "k",
  config: { auto_finalize: 1 } as any,
  destinationConfig: {},
  ...over,
});

describe("normalizeRule", () => {
  it("reads the explicit finalize_mode", () => {
    expect(normalizeRule(rule({ document_type: "invoice", finalize_mode: "draft" })))
      .toEqual({ docType: "invoice", finalize: false, series: null });
    expect(normalizeRule(rule({ document_type: "invoice", finalize_mode: "finalize" })))
      .toEqual({ docType: "invoice", finalize: true, series: null });
  });

  it("folds the legacy _draft suffix into finalize=false", () => {
    expect(normalizeRule(rule({ document_type: "invoice_receipt_draft" })))
      .toEqual({ docType: "invoice_receipt", finalize: false, series: null });
  });

  it("keeps the pre-0031 meaning of a plain type: force finalize", () => {
    expect(normalizeRule(rule({ document_type: "invoice_receipt" })))
      .toEqual({ docType: "invoice_receipt", finalize: true, series: null });
  });

  it("leaves a series-only rule inheriting auto_finalize", () => {
    expect(normalizeRule(rule({ series_name: "FR2026" })))
      .toEqual({ docType: null, finalize: null, series: "FR2026" });
  });

  it("lets an explicit finalize_mode win over the legacy suffix", () => {
    expect(normalizeRule(rule({ document_type: "invoice_draft", finalize_mode: "finalize" })))
      .toEqual({ docType: "invoice", finalize: true, series: null });
  });

  it("accepts simplified_invoice and rejects unknown types", () => {
    expect(normalizeRule(rule({ document_type: "simplified_invoice" })).docType).toBe("simplified_invoice");
    expect(normalizeRule(rule({ document_type: "receipt" })).docType).toBeNull();
  });

  it("is case- and whitespace-insensitive on the stored values", () => {
    expect(normalizeRule(rule({ document_type: "  Invoice_Receipt  ", finalize_mode: " DRAFT " })))
      .toEqual({ docType: "invoice_receipt", finalize: false, series: null });
  });
});

describe("parseStoredRoute", () => {
  it("round-trips a route", () => {
    const route = normalizeRule(rule({ document_type: "invoice", series_name: "A", finalize_mode: "draft" }));
    expect(parseStoredRoute(JSON.stringify(route))).toEqual(route);
  });

  it("degrades to null rather than throwing", () => {
    expect(parseStoredRoute(null)).toBeNull();
    expect(parseStoredRoute("")).toBeNull();
    expect(parseStoredRoute("{not json")).toBeNull();
    expect(parseStoredRoute("{}")).toBeNull();
  });

  it("drops a document type that is no longer valid", () => {
    expect(parseStoredRoute(JSON.stringify({ docType: "quote", finalize: false, series: null })))
      .toEqual({ docType: null, finalize: false, series: null });
  });
});

describe("matchTagRouting", () => {
  it("matches Stripe metadata as both key and key:value", () => {
    const o = order({ note_attributes: [{ name: "channel", value: "wholesale" }] });
    expect(matchTagRouting(o, [rule({ tag_name: "channel:wholesale" })])?.tag_name).toBe("channel:wholesale");
    expect(matchTagRouting(o, [rule({ tag_name: "channel" })])?.tag_name).toBe("channel");
    expect(matchTagRouting(o, [rule({ tag_name: "channel:retail" })])).toBeNull();
  });

  it("splits a comma-joined Shopify tag string", () => {
    const o = order({ tags: ["vip, wholesale"] });
    expect(matchTagRouting(o, [rule({ tag_name: "wholesale" })])?.tag_name).toBe("wholesale");
  });

  it("returns the first matching rule, not the most specific", () => {
    const o = order({ note_attributes: [{ name: "channel", value: "wholesale" }] });
    const rules = [rule({ tag_name: "channel" }), rule({ tag_name: "channel:wholesale" })];
    expect(matchTagRouting(o, rules)?.tag_name).toBe("channel");
  });

  it("returns null with no rules", () => {
    expect(matchTagRouting(order({ tags: ["x"] }), [])).toBeNull();
  });
});

describe("applyTagRoute", () => {
  it("maps type and series onto IX config keys", () => {
    const out = applyTagRoute(ctx(), "invoicexpress", {
      docType: "invoice_receipt", finalize: false, series: "FR2026",
    });
    expect(out.config.ix_document_type).toBe("invoice_receipt");
    expect(out.config.ix_sequence_name).toBe("FR2026");
    expect(out.config.auto_finalize).toBe(0);
  });

  it("maps type and series onto Moloni destinationConfig keys", () => {
    const out = applyTagRoute(
      ctx({ destinationConfig: { moloni_document_set_id: 42, moloni_document_type: "invoice" } }),
      "moloni",
      { docType: "simplified_invoice", finalize: true, series: "SET-B" },
    );
    expect(out.destinationConfig?.moloni_document_type).toBe("simplified_invoice");
    expect(out.destinationConfig?.moloni_document_set_name).toBe("SET-B");
    // The stale numeric id must be cleared or getMoloniCfg short-circuits on it
    // and the rule's document set is silently ignored.
    expect(out.destinationConfig?.moloni_document_set_id).toBeNull();
    expect(out.config.auto_finalize).toBe(1);
  });

  it("leaves auto_finalize alone when the rule inherits", () => {
    const out = applyTagRoute(ctx({ config: { auto_finalize: 1 } as any }), "moloni", {
      docType: null, finalize: null, series: "SET-B",
    });
    expect(out.config.auto_finalize).toBe(1);
  });

  it("does not clear the document set id when the rule sets no series", () => {
    const out = applyTagRoute(
      ctx({ destinationConfig: { moloni_document_set_id: 42 } }),
      "moloni",
      { docType: "invoice", finalize: null, series: null },
    );
    expect(out.destinationConfig?.moloni_document_set_id).toBe(42);
  });

  it("honours the finalize choice on destinations with no type/series mapping", () => {
    const out = applyTagRoute(ctx(), "vendus", { docType: "invoice", finalize: false, series: "X" });
    expect(out.config.auto_finalize).toBe(0);
  });
});

/**
 * Routing a sale to its destination country's document series.
 *
 * A merchant selling worldwide files each country into its own InvoiceXpress
 * series (FR-PT, FR-AU, …, FR-ROW for everything else). Until now the only
 * signals were Shopify tags and Stripe metadata, so the routing worked exactly
 * as well as the merchant's own metadata — a sale that arrived without a
 * `country` key fell into the default series with nothing to say it had.
 *
 * Opt-in, because it starts matching rule names nobody wrote for this purpose.
 */
describe("matchTagRouting by buyer country", () => {
  const auRule = rule({ tag_name: "country:AU", series_name: "FR-AU" });

  it("matches the billing country when the connection asked for it", () => {
    const match = matchTagRouting(
      order({ billing_address: { country_code: "au" } }),
      [auRule],
      { byCountry: true },
    );
    expect(match?.series_name).toBe("FR-AU");
  });

  it("also answers to the country_code spelling", () => {
    const match = matchTagRouting(
      order({ billing_address: { country_code: "AU" } }),
      [rule({ tag_name: "country_code:AU", series_name: "FR-AU" })],
      { byCountry: true },
    );
    expect(match?.series_name).toBe("FR-AU");
  });

  it("falls back to the shipping country when the payment collected no billing address", () => {
    const match = matchTagRouting(
      order({ billing_address: {}, shipping_address: { country_code: "AU" } }),
      [auRule],
      { byCountry: true },
    );
    expect(match?.series_name).toBe("FR-AU");
  });

  it("prefers the billing country — it is who the invoice is addressed to", () => {
    const match = matchTagRouting(
      order({
        billing_address: { country_code: "PT" },
        shipping_address: { country_code: "AU" },
      }),
      [auRule, rule({ tag_name: "country:PT", series_name: "FR-PT" })],
      { byCountry: true },
    );
    expect(match?.series_name).toBe("FR-PT");
  });

  it("matches nothing when the connection did not opt in", () => {
    const match = matchTagRouting(order({ billing_address: { country_code: "AU" } }), [auRule]);
    expect(match).toBeNull();
  });

  it("leaves the sale on the connection's own series when no rule names its country", () => {
    const match = matchTagRouting(
      order({ billing_address: { country_code: "JP" } }),
      [auRule],
      { byCountry: true },
    );
    expect(match).toBeNull();
  });

  it("does not fight metadata: the merchant's own country key is the same string", () => {
    const match = matchTagRouting(
      order({
        billing_address: { country_code: "AU" },
        note_attributes: [{ name: "country", value: "AU" }],
      }),
      [auRule],
      { byCountry: true },
    );
    expect(match?.series_name).toBe("FR-AU");
  });
});
