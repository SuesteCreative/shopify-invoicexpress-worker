import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  createMoloniTokenProvider,
  buildMoloniAuthorizeUrl,
  exchangeMoloniCode,
  refreshMoloniTokens,
  resolveMoloniApp,
  isMoloniOAuthConfig,
  MoloniReauthRequired,
} from "./moloni-oauth";

/**
 * Moloni's refresh token rotates on every use and dies after 14 idle days. Both
 * facts are load-bearing, and both are what these tests are about: a rotation
 * that is not persisted, or two rotations racing, leave a merchant with a dead
 * connection an hour later and no visible cause.
 */

const APP = { clientId: "dev_1", clientSecret: "secret_1", baseUrl: "https://api.moloni.pt/v1" };

function tokenResponse(access: string, refresh: string, expiresIn = 3600) {
  return new Response(JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: expiresIn }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** A D1 stand-in that records writes and reports how many rows each changed. */
function fakeDb(options: { casWins?: boolean; storedConfig?: Record<string, any> } = {}) {
  const casWins = options.casWins ?? true;
  const statements: Array<{ sql: string; args: any[] }> = [];
  return {
    statements,
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          return {
            async run() {
              statements.push({ sql, args });
              const isCas = sql.includes("moloni_refresh_token");
              return { meta: { changes: isCas && !casWins ? 0 : 1 } };
            },
            async first() {
              statements.push({ sql, args });
              return options.storedConfig
                ? { destination_config_json: JSON.stringify(options.storedConfig) }
                : null;
            },
          };
        },
      };
    },
  } as any;
}

const TARGET = () => ({
  userId: "user_1",
  source: "stripe_connect" as const,
  destination: "moloni" as const,
  destinationConfig: {
    moloni_auth_mode: "oauth",
    moloni_client_id: "dev_1",
    moloni_client_secret: "secret_1",
    moloni_access_token: "at_old",
    moloni_refresh_token: "rt_old",
    // Already expired, so every get() below is forced through a refresh.
    moloni_token_expires_at: new Date(Date.now() - 60_000).toISOString(),
  } as Record<string, any>,
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildMoloniAuthorizeUrl", () => {
  it("sends the merchant to Moloni's consent page, not to the API host", () => {
    const url = buildMoloniAuthorizeUrl("dev_1", "https://rioko.online/cb/abc");
    expect(url).toContain("https://www.moloni.pt/ac/root/oauth/");
    expect(url).toContain("response_type=code");
    expect(url).toContain("client_id=dev_1");
    expect(url).toContain("redirect_uri=https%3A%2F%2Frioko.online%2Fcb%2Fabc");
  });
});

describe("resolveMoloniApp", () => {
  it("prefers the merchant's own developer app", () => {
    const app = resolveMoloniApp(
      { MOLONI_APP_CLIENT_ID: "rioko", MOLONI_APP_CLIENT_SECRET: "rioko_secret" },
      { moloni_client_id: "theirs", moloni_client_secret: "their_secret" },
    );
    expect(app).toEqual({ clientId: "theirs", clientSecret: "their_secret", baseUrl: "https://api.moloni.pt/v1" });
  });

  it("falls back to a Rioko-owned app when the connection carries none", () => {
    const app = resolveMoloniApp({ MOLONI_APP_CLIENT_ID: "rioko", MOLONI_APP_CLIENT_SECRET: "rioko_secret" }, {});
    expect(app?.clientId).toBe("rioko");
  });

  it("honours the sandbox environment", () => {
    const app = resolveMoloniApp({}, { moloni_client_id: "a", moloni_client_secret: "b", moloni_environment: "sandbox" });
    expect(app?.baseUrl).toBe("https://apidemo.moloni.pt/v1");
  });

  it("is null when neither side has credentials", () => {
    expect(resolveMoloniApp({}, {})).toBeNull();
  });
});

describe("exchange and refresh", () => {
  it("dates the refresh token 14 days out, which is what the cron schedules against", async () => {
    fetchMock.mockResolvedValue(tokenResponse("at_new", "rt_new"));
    const tokens = await exchangeMoloniCode(APP, "code_1", "https://rioko.online/cb");

    expect(tokens.accessToken).toBe("at_new");
    expect(tokens.refreshToken).toBe("rt_new");
    const days = (Date.parse(tokens.refreshExpiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
  });

  it("refuses a grant that returns no refresh token", async () => {
    // It would work for an hour and then strand the connection with nothing to
    // refresh from — better to fail now, while someone is watching.
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 }));
    await expect(exchangeMoloniCode(APP, "code_1", "https://rioko.online/cb")).rejects.toThrow(/refresh_token/);
  });

  it("classifies a 400 as needing the merchant, not as a retry", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    await expect(refreshMoloniTokens(APP, "rt_dead")).rejects.toBeInstanceOf(MoloniReauthRequired);
  });

  it("classifies a 502 as transient, so the queue retries it", async () => {
    fetchMock.mockResolvedValue(new Response("upstream boom", { status: 502 }));
    const err = await refreshMoloniTokens(APP, "rt_ok").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(MoloniReauthRequired);
  });
});

describe("token provider", () => {
  it("returns the stored access token without calling Moloni when it is still fresh", async () => {
    const target = TARGET();
    target.destinationConfig.moloni_token_expires_at = new Date(Date.now() + 3600_000).toISOString();
    const provider = createMoloniTokenProvider({ DB: fakeDb() }, target)!;

    expect(await provider.get()).toBe("at_old");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes an expired token and persists the rotated pair", async () => {
    fetchMock.mockResolvedValue(tokenResponse("at_new", "rt_new"));
    const db = fakeDb();
    const target = TARGET();
    const provider = createMoloniTokenProvider({ DB: db }, target)!;

    expect(await provider.get()).toBe("at_new");

    // The in-memory config is updated too, or the other nine calls made while
    // issuing one document would each refresh again.
    expect(target.destinationConfig.moloni_access_token).toBe("at_new");
    expect(target.destinationConfig.moloni_refresh_token).toBe("rt_new");

    const write = db.statements.find((s: any) => s.sql.includes("UPDATE connections"));
    expect(write).toBeTruthy();
    // The compare-and-swap is on the token we started from.
    expect(write.args).toContain("rt_old");
  });

  it("refreshes once even when ten calls arrive together", async () => {
    fetchMock.mockResolvedValue(tokenResponse("at_new", "rt_new"));
    const provider = createMoloniTokenProvider({ DB: fakeDb() }, TARGET())!;

    const results = await Promise.all(Array.from({ length: 10 }, () => provider.get()));

    expect(results.every((t) => t === "at_new")).toBe(true);
    // One grant call. Ten would rotate the refresh token out from under itself
    // nine times and leave eight of the results holding dead tokens.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the winner's token when another worker rotated first", async () => {
    fetchMock.mockResolvedValue(tokenResponse("at_ours", "rt_ours"));
    const db = fakeDb({
      casWins: false,
      storedConfig: {
        moloni_access_token: "at_winner",
        moloni_refresh_token: "rt_winner",
        moloni_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      },
    });
    const target = TARGET();
    const provider = createMoloniTokenProvider({ DB: db }, target)!;

    expect(await provider.get()).toBe("at_winner");
    expect(target.destinationConfig.moloni_refresh_token).toBe("rt_winner");
  });

  it("marks the connection for reauthorisation when Moloni rejects the refresh token", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    const db = fakeDb();
    const provider = createMoloniTokenProvider({ DB: db }, TARGET())!;

    await expect(provider.get()).rejects.toBeInstanceOf(MoloniReauthRequired);

    const marked = db.statements.find((s: any) => s.sql.includes("status = 'error'"));
    expect(marked).toBeTruthy();
  });

  it("leaves the connection alone when Moloni merely fails to answer", async () => {
    // A 502 is transport noise. Taking a working merchant offline for it would
    // turn a blip into a support call.
    fetchMock.mockResolvedValue(new Response("boom", { status: 502 }));
    const db = fakeDb();
    const provider = createMoloniTokenProvider({ DB: db }, TARGET())!;

    await expect(provider.get()).rejects.toThrow();
    expect(db.statements.find((s: any) => s.sql.includes("status = 'error'"))).toBeUndefined();
  });

  it("is null for a connection with no app credentials at all", () => {
    const target = TARGET();
    delete target.destinationConfig.moloni_client_id;
    delete target.destinationConfig.moloni_client_secret;
    expect(createMoloniTokenProvider({ DB: fakeDb() }, target)).toBeNull();
  });
});

describe("isMoloniOAuthConfig", () => {
  it("only recognises connections that opted in", () => {
    expect(isMoloniOAuthConfig({ moloni_auth_mode: "oauth" })).toBe(true);
    // Every existing password-grant connection: no marker, no provider, no
    // change to how it authenticates.
    expect(isMoloniOAuthConfig({ moloni_username: "a", moloni_password: "b" })).toBe(false);
    expect(isMoloniOAuthConfig(undefined)).toBe(false);
  });
});
