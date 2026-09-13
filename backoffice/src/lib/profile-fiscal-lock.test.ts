import { describe, it, expect } from "vitest";

/**
 * The NIF and the legal company name stop being editable once the account is
 * registered — and that has to be true of the STATEMENT, not of the form.
 *
 * A disabled input is a suggestion to anybody who can send a POST, so the guard
 * lives in the one UPDATE every caller routes through
 * (backoffice/src/app/api/user/profile/route.ts). This runs that exact SQL,
 * because the failure it prevents is fiscal: a merchant changing the number that
 * their already-issued Kapta invoices print and that the payment matcher pairs
 * on.
 *
 * Kept in step by hand with the route: if the SET clause there changes, this
 * string changes with it. It is copied rather than imported because the route
 * module pulls in Clerk and the Cloudflare request context, neither of which
 * exists here — the same reason lib/client-code takes its D1 handle as an
 * argument.
 */
const COLUMNS = `
    SET nif = CASE WHEN registration_completed = 1 AND ? = 0 THEN nif ELSE ? END,
        name = COALESCE(NULLIF(?, ''), name),
        company_name = CASE WHEN registration_completed = 1 AND ? = 0 THEN company_name ELSE ? END,
        fiscal_address = ?,
        phone = ?,
        website = ?,
        registration_completed = 1,
        privacy_policy_accepted = ?`;

const UPDATE_SQL = `UPDATE users${COLUMNS} WHERE id = ?`;

function harness(row: { registration_completed: number; nif: string | null; company_name: string | null }) {
    const nodeSqlite = "node:sqlite";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require(nodeSqlite);
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`CREATE TABLE users (
        id TEXT PRIMARY KEY, name TEXT, nif TEXT, company_name TEXT,
        fiscal_address TEXT, phone TEXT, website TEXT,
        registration_completed INTEGER DEFAULT 0, privacy_policy_accepted INTEGER DEFAULT 0
    );`);
    sqlite.prepare(
        "INSERT INTO users (id, name, nif, company_name, fiscal_address, registration_completed) VALUES ('user_a', 'Titular', ?, ?, 'Rua Velha 1', ?)",
    ).run(row.nif, row.company_name, row.registration_completed);

    return {
        /** The route's own bind order. */
        save(payload: { mayEditFiscal: 0 | 1; nif: string; company_name: string; fiscal_address: string }) {
            sqlite.prepare(UPDATE_SQL).run(
                payload.mayEditFiscal, payload.nif,
                "Titular",
                payload.mayEditFiscal, payload.company_name,
                payload.fiscal_address,
                null, null,
                1,
                "user_a",
            );
        },
        row: () => sqlite.prepare("SELECT * FROM users WHERE id = 'user_a'").get() as any,
    };
}

describe("the fiscal identity, once registered", () => {
    it("does not move for the merchant, however the request is shaped", () => {
        const h = harness({ registration_completed: 1, nif: "517569493", company_name: "BIKINI BOOKS UNIPESSOAL LDA" });

        h.save({ mayEditFiscal: 0, nif: "999999999", company_name: "Outra Coisa Lda", fiscal_address: "Rua Nova 2" });

        const after = h.row();
        expect(after.nif).toBe("517569493");
        expect(after.company_name).toBe("BIKINI BOOKS UNIPESSOAL LDA");
        // What they ARE allowed to change still changes: the lock is on two
        // fields, not on the form.
        expect(after.fiscal_address).toBe("Rua Nova 2");
    });

    it("moves for an operator, which is the escape hatch support needs", () => {
        const h = harness({ registration_completed: 1, nif: "517569493", company_name: "BIKINI BOOKS UNIPESSOAL LDA" });

        h.save({ mayEditFiscal: 1, nif: "999999999", company_name: "Outra Coisa Lda", fiscal_address: "Rua Nova 2" });

        const after = h.row();
        expect(after.nif).toBe("999999999");
        expect(after.company_name).toBe("Outra Coisa Lda");
    });
});

describe("the first registration", () => {
    it("writes the NIF, because there is nothing to protect yet", () => {
        const h = harness({ registration_completed: 0, nif: null, company_name: null });

        h.save({ mayEditFiscal: 0, nif: "517569493", company_name: "Bikini Books Unipessoal Lda", fiscal_address: "Rua Velha 1" });

        const after = h.row();
        expect(after.nif).toBe("517569493");
        expect(after.company_name).toBe("Bikini Books Unipessoal Lda");
        expect(after.registration_completed).toBe(1);
    });

    it("locks from the second save onwards", () => {
        const h = harness({ registration_completed: 0, nif: null, company_name: null });

        h.save({ mayEditFiscal: 0, nif: "517569493", company_name: "Bikini Books Unipessoal Lda", fiscal_address: "Rua Velha 1" });
        h.save({ mayEditFiscal: 0, nif: "111111111", company_name: "Tentativa Lda", fiscal_address: "Rua Velha 1" });

        expect(h.row().nif).toBe("517569493");
    });
});
