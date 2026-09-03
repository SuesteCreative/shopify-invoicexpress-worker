import { describe, it, expect, vi, afterEach } from "vitest";
import {
  GATEWAY_ERROR_HEADER,
  GATEWAY_KEY_HEADER,
  LODGIFY_DIRECT_BASE,
  LODGIFY_USER_AGENT,
  LodgifyGatewayConfigError,
  assertSafeBookingId,
  describeLodgifyEgress,
  isAllowedLodgifyPath,
  isGatewayFailure,
  lodgifyFetch,
  resolveLodgifyGateway,
} from "./lodgify-api";

/**
 * Lodgify blocked this Worker's egress on 2026-08-02 and can only allowlist by
 * IP address, so every assertion here is about the same thing: a Lodgify call
 * must leave through the one address Lodgify trusts, or not leave at all.
 *
 * The dangerous failure is not an exception — it is a request that quietly goes
 * out the wrong door and re-earns the block for every merchant. So the tests
 * that matter most are the ones proving we refuse.
 */

const RELAY = { LODGIFY_GATEWAY_URL: "https://relay.example.com", LODGIFY_GATEWAY_KEY: "s3cret" };

afterEach(() => { vi.unstubAllGlobals(); });

/** Capture what `lodgifyFetch` would put on the wire. */
function stubFetch(response?: Partial<{ status: number; headers: Record<string, string> }>) {
  const calls: Array<{ url: string; init: any }> = [];
  vi.stubGlobal("fetch", (url: string, init: any) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(new Response("{}", {
      status: response?.status ?? 200,
      headers: response?.headers ?? {},
    }));
  });
  return calls;
}

describe("resolveLodgifyGateway — fail closed", () => {
  it("routes through the relay when mode is gateway and both values are present", () => {
    const g = resolveLodgifyGateway({ LODGIFY_EGRESS_MODE: "gateway", ...RELAY });
    expect(g).toEqual({ base: "https://relay.example.com", key: "s3cret", relayed: true });
  });

  it("treats a MISSING mode as gateway — a lost var must not restore direct egress", () => {
    // `wrangler deploy` from a machine without the full config has dropped this
    // Worker's variables before. If absent meant "direct", that accident would
    // silently re-earn the block with no error anywhere.
    expect(() => resolveLodgifyGateway({})).toThrow(LodgifyGatewayConfigError);
    expect(() => resolveLodgifyGateway(undefined)).toThrow(LodgifyGatewayConfigError);
  });

  it("refuses gateway mode with a missing URL or key, naming what is missing", () => {
    expect(() => resolveLodgifyGateway({ LODGIFY_GATEWAY_KEY: "k" }))
      .toThrow(/LODGIFY_GATEWAY_URL/);
    expect(() => resolveLodgifyGateway({ LODGIFY_GATEWAY_URL: "https://r.example" }))
      .toThrow(/LODGIFY_GATEWAY_KEY/);
    // Whitespace is not configuration.
    expect(() => resolveLodgifyGateway({ LODGIFY_GATEWAY_URL: "  ", LODGIFY_GATEWAY_KEY: "  " }))
      .toThrow(LodgifyGatewayConfigError);
  });

  it("goes direct ONLY on an explicit, exact opt-out", () => {
    const g = resolveLodgifyGateway({ LODGIFY_EGRESS_MODE: "direct" });
    expect(g).toEqual({ base: LODGIFY_DIRECT_BASE, key: null, relayed: false });
    // Case and padding are forgiven; a typo is not.
    expect(resolveLodgifyGateway({ LODGIFY_EGRESS_MODE: " DIRECT " }).relayed).toBe(false);
    expect(() => resolveLodgifyGateway({ LODGIFY_EGRESS_MODE: "dircet" })).toThrow();
  });

  it("strips trailing slashes so paths do not double up", () => {
    const g = resolveLodgifyGateway({ LODGIFY_GATEWAY_URL: "https://relay.example.com//", LODGIFY_GATEWAY_KEY: "k" });
    expect(g.base).toBe("https://relay.example.com");
  });
});

describe("lodgifyFetch", () => {
  it("sends the relay secret and one honest User-Agent, and never leaks the key upstream", async () => {
    const calls = stubFetch();
    const gateway = resolveLodgifyGateway({ ...RELAY });
    await lodgifyFetch("/v1/reservation?limit=1", { apiKey: "merchant-key", gateway });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://relay.example.com/v1/reservation?limit=1");
    expect(calls[0].init.headers["X-ApiKey"]).toBe("merchant-key");
    expect(calls[0].init.headers[GATEWAY_KEY_HEADER]).toBe("s3cret");
    expect(calls[0].init.headers["User-Agent"]).toBe(LODGIFY_USER_AGENT);
  });

  it("omits the gateway header when going direct", async () => {
    const calls = stubFetch();
    await lodgifyFetch("/v1/reservation", {
      apiKey: "k", gateway: resolveLodgifyGateway({ LODGIFY_EGRESS_MODE: "direct" }),
    });
    expect(calls[0].url).toBe(`${LODGIFY_DIRECT_BASE}/v1/reservation`);
    expect(calls[0].init.headers[GATEWAY_KEY_HEADER]).toBeUndefined();
  });

  it("carries a default timeout — a hung relay must not hold a subrequest open", async () => {
    const calls = stubFetch();
    await lodgifyFetch("/v1/reservation", { apiKey: "k", gateway: resolveLodgifyGateway({ ...RELAY }) });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects a full URL — the origin is the gateway's business, not the call site's", async () => {
    stubFetch();
    await expect(lodgifyFetch("https://api.lodgify.com/v1/reservation", {
      apiKey: "k", gateway: resolveLodgifyGateway({ ...RELAY }),
    })).rejects.toThrow(/absolute path/);
  });

  it("rejects a path the relay would not forward, before it goes out", async () => {
    const calls = stubFetch();
    await expect(lodgifyFetch("/v1/properties", {
      apiKey: "k", gateway: resolveLodgifyGateway({ ...RELAY }),
    })).rejects.toThrow(/allowlist/);
    expect(calls).toHaveLength(0);
  });

  it("forwards every path the onboarding wizard and the poll actually use", () => {
    for (const p of [
      "/v1/reservation?offset=0",
      "/v2/reservations/12345",
      "/v2/reservations/bookings?page=1",
      "/webhooks/v1/list",
      "/webhooks/v1/subscribe",
      "/webhooks/v1/unsubscribe/9",
      "/v2/webhooks/9",
    ]) expect(isAllowedLodgifyPath(p)).toBe(true);
  });
});

describe("assertSafeBookingId", () => {
  it("accepts the ids Lodgify actually issues", () => {
    expect(assertSafeBookingId(12345)).toBe("12345");
    expect(assertSafeBookingId("B-2026_01")).toBe("B-2026_01");
  });

  it("refuses an id that would steer the proxied path", () => {
    // The inbound webhook accepts unsigned bodies when the connection has no
    // stored secret (the normal state for manually registered webhooks), so this
    // value can come from a stranger. Interpolated raw it defeats the relay's
    // path allowlist and burns the allowlisted IP with someone else's traffic.
    expect(() => assertSafeBookingId("bookings?limit=9999&x=")).toThrow();
    expect(() => assertSafeBookingId("../../v1/properties")).toThrow();
    expect(() => assertSafeBookingId("")).toThrow();
    expect(() => assertSafeBookingId("a".repeat(65))).toThrow();
  });
});

describe("isGatewayFailure", () => {
  it("tells our box failing apart from Lodgify failing", () => {
    expect(isGatewayFailure(new Response("", { status: 502, headers: { [GATEWAY_ERROR_HEADER]: "upstream_502" } }))).toBe(true);
    // A Lodgify 429 carries no relay header: that is a rate limit or a block,
    // and it must keep its own retry/backoff path.
    expect(isGatewayFailure(new Response("", { status: 429 }))).toBe(false);
    expect(isGatewayFailure(new Response("", { status: 200 }))).toBe(false);
  });
});

describe("describeLodgifyEgress", () => {
  it("prints the host and never the secret — this text reaches logs and alerts", () => {
    const line = describeLodgifyEgress(resolveLodgifyGateway({ ...RELAY }));
    expect(line).toContain("relay.example.com");
    expect(line).not.toContain("s3cret");
    expect(describeLodgifyEgress(resolveLodgifyGateway({ LODGIFY_EGRESS_MODE: "direct" })))
      .toBe("direct (no fixed IP)");
  });
});
