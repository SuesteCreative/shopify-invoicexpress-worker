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
 * Two ways it went wrong on the day it shipped, both pinned below: a save with
 * no NIF (the Conta page sends the profile as it is) closed an unfinished
 * registration, and the guard then locked that empty NIF for good.
 *
 * Kept in step by hand with the route: if the SET clause there changes, this
 * string changes with it. It is copied rather than imported because the route
 * module pulls in Clerk and the Cloudflare request context, neither of which
 * exists here — the same reason lib/client-code takes its D1 handle as an
 * argument.
 */
const COLUMNS = `
    SET nif = CASE WHEN registration_completed = 1 AND ? = 0 AND COALESCE(nif, '') <> '' THEN nif ELSE ? END,
        name = COALESCE(NULLIF(?, ''), name),
        company_name = CASE WHEN registration_completed = 1 AND ? = 0 AND COALESCE(company_name, '') <> '' THEN company_name ELSE ? END,
        fiscal_address = ?,
        phone = ?,
        website = ?,
        registration_completed = CASE WHEN TRIM(COALESCE(?, '')) = '' THEN registration_completed ELSE 1 END,
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
                payload.nif,
                1,
                "user_a",
            );
        },
        row: () => sqlite.prepare("SELECT * FROM users WHERE id = 'user_a'").get() as any,
    };
}

describe("the statement", () => {
    it("binds exactly as many values as it has placeholders", () => {
        // The route's bind list grows by hand with every CASE; D1 refuses a
        // mismatch at runtime, on the row it was about to write.
        expect((UPDATE_SQL.match(/\?/g) ?? []).length).toBe(11);
    });
});

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

    it("can still be filled where it was left EMPTY — there is nothing invoiced against it", () => {
        // The state the Conta page used to leave behind. Locking an empty NIF
        // protects nothing and strands the account.
        const h = harness({ registration_completed: 1, nif: "", company_name: null });

        h.save({ mayEditFiscal: 0, nif: "517569493", company_name: "Bikini Books Unipessoal Lda", fiscal_address: "Rua Velha 1" });

        const after = h.row();
        expect(after.nif).toBe("517569493");
        expect(after.company_name).toBe("Bikini Books Unipessoal Lda");
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

describe("a save that carries no NIF", () => {
    it("does not complete a registration", () => {
        // What the Conta page sends for an account that never finished
        // onboarding: the profile as it is, NIF empty.
        const h = harness({ registration_completed: 0, nif: null, company_name: null });

        h.save({ mayEditFiscal: 0, nif: "", company_name: "", fiscal_address: "Rua Nova 2" });

        const after = h.row();
        expect(after.registration_completed).toBe(0);
        expect(after.fiscal_address).toBe("Rua Nova 2");
    });

    it("leaves the onboarding free to write the real NIF afterwards", () => {
        const h = harness({ registration_completed: 0, nif: null, company_name: null });

        h.save({ mayEditFiscal: 0, nif: "", company_name: "", fiscal_address: "Rua Nova 2" });
        h.save({ mayEditFiscal: 0, nif: "517569493", company_name: "Bikini Books Unipessoal Lda", fiscal_address: "Rua Nova 2" });

        const after = h.row();
        expect(after.nif).toBe("517569493");
        expect(after.registration_completed).toBe(1);
    });
});

/**
 * The consent date records the first tick of the box (migration 0049), so it
 * must never be invented. Copied from the route's statement like COLUMNS above:
 * every CASE reads the row as it was before the UPDATE.
 */
const CONSENT_SQL = `
    UPDATE users SET privacy_policy_accepted = ?,
        privacy_policy_accepted_at = CASE
            WHEN ? = 1 AND COALESCE(privacy_policy_accepted, 0) = 0 THEN CURRENT_TIMESTAMP
            ELSE privacy_policy_accepted_at END
     WHERE id = ?`;

function consentHarness(row: { accepted: number; at: string | null }) {
    const nodeSqlite = "node:sqlite";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require(nodeSqlite);
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE users (id TEXT PRIMARY KEY, privacy_policy_accepted INTEGER DEFAULT 0, privacy_policy_accepted_at TEXT)");
    sqlite.prepare("INSERT INTO users VALUES ('user_a', ?, ?)").run(row.accepted, row.at);
    return {
        save: (accepted: 0 | 1) => sqlite.prepare(CONSENT_SQL).run(accepted, accepted, "user_a"),
        at: () => (sqlite.prepare("SELECT privacy_policy_accepted_at AS at FROM users").get() as any).at,
    };
}

describe("the privacy consent date", () => {
    it("is stamped when the box is ticked for the first time", () => {
        const h = consentHarness({ accepted: 0, at: null });
        h.save(1);
        expect(h.at()).toBeTruthy();
    });

    it("is not invented for an account that accepted before dates were kept", () => {
        // 27 live accounts: accepted, no date. A later address correction must
        // not make today the day they consented.
        const h = consentHarness({ accepted: 1, at: null });
        h.save(1);
        expect(h.at()).toBeNull();
    });

    it("never moves once it is there", () => {
        const h = consentHarness({ accepted: 1, at: "2026-06-01 10:00:00" });
        h.save(1);
        expect(h.at()).toBe("2026-06-01 10:00:00");
    });
});
