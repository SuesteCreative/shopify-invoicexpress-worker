import { describe, it, expect } from "vitest";
import { missingDestinationCredential, runConnectionHealthCheck } from "./connection-health";

/**
 * The three live shapes this was written for, on 2026-09-12:
 *
 *   Bestisafil  — no `integrations` row at all, never had one.
 *   MeetFrank   — had one for months; an admin delete took it away.
 *   Farracemota — row still there, both credentials blanked.
 *
 * All three read as ACTIVE and issued nothing. What matters is not only that
 * each is caught but that the sentence sent to the merchant names the step
 * they have to go and do.
 */
describe("missingDestinationCredential — InvoiceXpress", () => {
  it("passes a connection with both halves", () => {
    expect(missingDestinationCredential("invoicexpress", {}, { ix_account_name: "whmservicesunipes", ix_api_key: "k" }))
      .toBeNull();
  });

  it("catches an account with no integrations row", () => {
    expect(missingDestinationCredential("invoicexpress", {}, null))
      .toMatch(/Não há credenciais de InvoiceXpress/);
  });

  it("catches a row whose credentials were blanked", () => {
    expect(missingDestinationCredential("invoicexpress", {}, { ix_account_name: "", ix_api_key: null }))
      .toMatch(/por preencher/);
  });

  it("says which half is missing when only one is", () => {
    expect(missingDestinationCredential("invoicexpress", {}, { ix_account_name: "conta", ix_api_key: "  " }))
      .toMatch(/chave API/);
    expect(missingDestinationCredential("invoicexpress", {}, { ix_account_name: "", ix_api_key: "k" }))
      .toMatch(/nome da conta/);
  });
});

describe("missingDestinationCredential — the other destinations", () => {
  it("accepts Moloni on OAuth or on the legacy pair", () => {
    expect(missingDestinationCredential("moloni", { moloni_auth_mode: "oauth" }, null)).toBeNull();
    expect(missingDestinationCredential("moloni", { moloni_refresh_token: "r" }, null)).toBeNull();
    expect(missingDestinationCredential("moloni", { moloni_client_id: "c", moloni_username: "u" }, null)).toBeNull();
    expect(missingDestinationCredential("moloni", {}, null)).toMatch(/Moloni/);
  });

  it("accepts Vendus on its api key", () => {
    expect(missingDestinationCredential("vendus", { vendus_api_key: "v" }, null)).toBeNull();
    expect(missingDestinationCredential("vendus", {}, null)).toMatch(/Vendus/);
  });

  it("stays quiet about a destination it does not know", () => {
    expect(missingDestinationCredential("something_new", {}, null)).toBeNull();
  });

  it("does not fault a Moloni connection for having no InvoiceXpress row", () => {
    // The legacy row is InvoiceXpress's credential store and nobody else's.
    // Reading it for every destination is how a healthy Moloni merchant would
    // have been emailed every night about a system they do not use.
    expect(missingDestinationCredential("moloni", { moloni_auth_mode: "oauth" }, { ix_account_name: null, ix_api_key: null }))
      .toBeNull();
  });
});

/**
 * The alarm has to close on evidence, not on silence.
 *
 * Bestisafil and Farracemota each carried an open `connection_unconfigured`
 * for a day over a connection that was issuing documents the whole time: the
 * nightly check saw them healthy and said nothing, and only the 24h staleness
 * sweep eventually shut them — which reads the same whether a thing was fixed
 * or merely went quiet.
 */
describe("runConnectionHealthCheck — closing the alarm", () => {
  const connection = {
    user_id: "user_1", connection_id: "conn_1",
    source_kind: "stripe_connect", destination_kind: "invoicexpress",
    destination_config_json: JSON.stringify({ ix_account_name: "bestisafilsocieda", ix_api_key: "k" }),
    // No legacy row: the shape that started all of this.
    ix_account_name: null, ix_api_key: null,
  };

  /** Records every write so the test can assert on what was closed. */
  const fakeEnv = (row: any) => {
    const writes: Array<{ sql: string; binds: any[] }> = [];
    return {
      writes,
      env: {
        DB: {
          prepare(sql: string) {
            return {
              bind(...binds: any[]) {
                if (/^\s*UPDATE incidents/i.test(sql)) writes.push({ sql, binds });
                return this;
              },
              all: async () => ({ results: [row] }),
              run: async () => ({ meta: { changes: 1 } }),
              first: async () => null,
            };
          },
        },
      } as any,
    };
  };

  it("resolves the open alarm when the connection is configured again", async () => {
    const { env, writes } = fakeEnv(connection);
    const result = await runConnectionHealthCheck(env);

    expect(result.unconfigured).toBe(0);
    expect(result.resolved).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0].sql).toContain("connection_unconfigured");
    // `resolved`, never `auto_resolved`: reportIncident reopens only that one,
    // so closing it any other way would swallow the next real failure inside
    // the same daily bucket.
    expect(writes[0].sql).toContain("'resolved'");
    expect(writes[0].sql).not.toContain("auto_resolved");
    expect(writes[0].binds).toContain("conn_1");
  });

  it("closes nothing while the credentials are still missing", async () => {
    const { env, writes } = fakeEnv({ ...connection, destination_config_json: "{}" });
    const result = await runConnectionHealthCheck(env);

    expect(result.unconfigured).toBe(1);
    expect(result.resolved).toBe(0);
    expect(writes).toHaveLength(0);
  });

  it("writes nothing at all on a dry run", async () => {
    const { env, writes } = fakeEnv(connection);
    const result = await runConnectionHealthCheck(env, { dryRun: true });

    expect(result.resolved).toBe(0);
    expect(writes).toHaveLength(0);
  });
});
