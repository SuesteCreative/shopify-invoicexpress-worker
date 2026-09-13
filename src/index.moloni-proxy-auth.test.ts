import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index";

// The Moloni proxy takes raw Moloni credentials in its body and relays them from
// the Worker's IP. Unauthenticated, that is an open relay. These go through the
// real worker entry point so a route that loses its requireAdmin line fails here.

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const env = { ADMIN_API_KEY: "test-admin-key" } as any;
const creds = { client_id: "id", client_secret: "secret", username: "user", password: "pass", company_id: "1" };

function post(path: string, headers: Record<string, string>, body: unknown) {
  return worker.fetch(
    new Request(`https://worker.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
}

describe.each(["/moloni-proxy/companies", "/moloni-proxy/document-sets"])("%s", (path) => {
  afterEach(() => vi.restoreAllMocks());

  it("refuses a call without the admin key and never reaches Moloni", async () => {
    const upstream = vi.spyOn(globalThis, "fetch");
    const res = await post(path, {}, creds);
    expect(res.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses a wrong admin key", async () => {
    const upstream = vi.spyOn(globalThis, "fetch");
    const res = await post(path, { "x-api-key": "wrong" }, creds);
    expect(res.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("lets the right key through to the handler", async () => {
    // An empty body stops at the handler's own validation, so no network.
    const res = await post(path, { "x-api-key": "test-admin-key" }, {});
    expect(res.status).toBe(400);
  });
});
