import { describe, it, expect } from "vitest";
import { BILLING_IDENTITY_COLUMNS } from "./billing-identity";

/**
 * Which identity a payment is matched on.
 *
 * The failure this guards against is silent: with no name and no NIF the
 * matcher falls back to amount and date, and a 50,00 EUR payment then lands on
 * whatever 50,00 EUR document is nearest in time — another client's, cancelled,
 * whatever. So the SQL runs for real here, on the two shapes that exist in the
 * fleet: a client who went through checkout, and a client invited with a link
 * carrying a subscription, whose subscription row has no fiscal column at all.
 */

function db() {
    // Named indirectly, as the other SQL tests here do, so the bundler does not
    // try to resolve a node: builtin for the edge runtime.
    const nodeSqlite = "node:sqlite";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require(nodeSqlite);
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
        CREATE TABLE users (
            id TEXT PRIMARY KEY, email TEXT, name TEXT, nif TEXT,
            company_name TEXT, fiscal_address TEXT
        );
        CREATE TABLE subscriptions (
            user_id TEXT, connection_key TEXT, nif TEXT, name TEXT,
            email TEXT, address TEXT, zip TEXT
        );
    `);
    return sqlite;
}

const QUERY = `
    SELECT ${BILLING_IDENTITY_COLUMNS}
    FROM users u
    LEFT JOIN subscriptions s ON s.user_id = u.id
    WHERE u.id = ?
    GROUP BY u.id
`;

function identity(sqlite: any, userId: string) {
    return sqlite.prepare(QUERY).get(userId);
}

describe("billing identity", () => {
    it("takes the checkout copy when the client went through a payment form", () => {
        const sqlite = db();
        sqlite.exec(`
            INSERT INTO users VALUES ('u1', 'perfil@x.pt', 'Perfil', '111111111', '', 'Rua do Perfil');
            INSERT INTO subscriptions VALUES ('u1', 'stripe:moloni', '222222222', 'Checkout Lda', 'checkout@x.pt', 'Rua do Checkout', '1000-001');
        `);
        expect(identity(sqlite, "u1")).toMatchObject({
            nif: "222222222", name: "Checkout Lda", email: "checkout@x.pt",
            address: "Rua do Checkout", zip: "1000-001",
        });
    });

    it("falls back to the profile when the invite link skipped the checkout", () => {
        const sqlite = db();
        sqlite.exec(`
            INSERT INTO users VALUES ('u2', 'geral@one2rent.pt', 'Emanuel de Sousa', '222373555', '', 'Azinhaga dos Trabalhadores 1 2F');
            INSERT INTO subscriptions VALUES ('u2', 'stripe_connect:moloni', NULL, NULL, NULL, NULL, NULL);
        `);
        expect(identity(sqlite, "u2")).toMatchObject({
            nif: "222373555", name: "Emanuel de Sousa", email: "geral@one2rent.pt",
            address: "Azinhaga dos Trabalhadores 1 2F",
        });
    });

    it("prefers the company name over the person's, and never answers an empty string", () => {
        const sqlite = db();
        sqlite.exec(`
            INSERT INTO users VALUES ('u3', 'geral@empresa.pt', 'Dono', '500000000', 'Empresa Lda', '');
            INSERT INTO subscriptions VALUES ('u3', 'stripe:ix', '', '', '', '', '');
        `);
        const row: any = identity(sqlite, "u3");
        expect(row.name).toBe("Empresa Lda");
        expect(row.address).toBeNull();
        expect(row.zip).toBeNull();
    });

    it("does not let a second connection's empty row answer for the one that has the data", () => {
        const sqlite = db();
        sqlite.exec(`
            INSERT INTO users VALUES ('u4', 'dois@x.pt', 'Dois', NULL, NULL, NULL);
            INSERT INTO subscriptions VALUES ('u4', 'stripe:moloni', '333333333', 'Dois Lda', 'dois@x.pt', 'Rua Dois', '2000-002');
            INSERT INTO subscriptions VALUES ('u4', 'lodgify:moloni', NULL, NULL, NULL, NULL, NULL);
        `);
        const rows = sqlite.prepare(QUERY).all("u4");
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ nif: "333333333", name: "Dois Lda" });
    });

    it("answers nothing rather than something wrong when neither side knows", () => {
        const sqlite = db();
        sqlite.exec(`INSERT INTO users VALUES ('u5', NULL, NULL, NULL, NULL, NULL);`);
        expect(identity(sqlite, "u5")).toMatchObject({
            nif: null, name: null, email: null, address: null, zip: null,
        });
    });
});
