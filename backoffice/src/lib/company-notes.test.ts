import { describe, it, expect } from "vitest";
import { saveCompanyNotes, MAX_NOTES_CHARS } from "./company-notes";

/**
 * The note is written from two screens — the fiscal console and the client
 * record — and both go through here. What earns a test is the part that did not
 * exist before: the audit row. Migration 0035 declared a `company_rules` scope
 * and nothing ever wrote one, so a note could be replaced with no record of who
 * did it or what it said before.
 */
function harness() {
    const nodeSqlite = "node:sqlite";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require(nodeSqlite);
    const sqlite = new DatabaseSync(":memory:");

    sqlite.exec(`
        CREATE TABLE company_rules (
            user_id TEXT PRIMARY KEY, notes TEXT, updated_at TEXT, updated_by TEXT
        );
        CREATE TABLE config_audit (
            id TEXT PRIMARY KEY, user_id TEXT, actor TEXT, scope TEXT, field TEXT,
            old_value TEXT, new_value TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        -- A second account. Nothing below may reach it.
        INSERT INTO company_rules (user_id, notes) VALUES ('user_b', 'não me toques');
    `);

    const db = {
        prepare(sql: string) {
            const stmt = sqlite.prepare(sql);
            let bound: unknown[] = [];
            const api = {
                bind(...args: unknown[]) { bound = args; return api; },
                async first() { return stmt.get(...bound) ?? null; },
                async run() {
                    const r = stmt.run(...bound);
                    return { meta: { changes: Number(r.changes ?? 0) } };
                },
            };
            return api;
        },
    } as any;

    const notesOf = (u: string) =>
        (sqlite.prepare("SELECT notes FROM company_rules WHERE user_id = ?").get(u) as any)?.notes ?? null;
    const audits = () =>
        sqlite.prepare("SELECT scope, field, old_value, new_value FROM config_audit").all() as any[];

    return { db, notesOf, audits };
}

describe("saveCompanyNotes", () => {
    it("writes the note and says so in the audit trail", async () => {
        const h = harness();
        const res = await saveCompanyNotes(h.db, { accountId: "user_a", actor: "op_1", notes: "portes a 0% por decisão de 12/08" });

        expect(res.unchanged).toBe(false);
        expect(h.notesOf("user_a")).toBe("portes a 0% por decisão de 12/08");
        expect(h.audits()).toEqual([{
            scope: "company_rules", field: "notes",
            old_value: null, new_value: "portes a 0% por decisão de 12/08",
        }]);
    });

    it("records what the note said before it was replaced", async () => {
        const h = harness();
        await saveCompanyNotes(h.db, { accountId: "user_a", actor: "op_1", notes: "primeiro" });
        await saveCompanyNotes(h.db, { accountId: "user_a", actor: "op_2", notes: "segundo" });

        expect(h.notesOf("user_a")).toBe("segundo");
        expect(h.audits().map((a) => [a.old_value, a.new_value]))
            .toEqual([[null, "primeiro"], ["primeiro", "segundo"]]);
    });

    // The field saves on blur, which fires whether or not anyone typed. Without
    // this the trail fills with rows that record nothing.
    it("does not write or audit an identical note", async () => {
        const h = harness();
        await saveCompanyNotes(h.db, { accountId: "user_a", actor: "op_1", notes: "igual" });
        const res = await saveCompanyNotes(h.db, { accountId: "user_a", actor: "op_1", notes: "igual" });

        expect(res.unchanged).toBe(true);
        expect(h.audits()).toHaveLength(1);
    });

    it("caps the note rather than letting the write fail", async () => {
        const h = harness();
        await saveCompanyNotes(h.db, { accountId: "user_a", actor: "op_1", notes: "x".repeat(MAX_NOTES_CHARS + 500) });

        expect(h.notesOf("user_a")).toHaveLength(MAX_NOTES_CHARS);
    });

    it("never reaches another account's note", async () => {
        const h = harness();
        await saveCompanyNotes(h.db, { accountId: "user_a", actor: "op_1", notes: "só do A" });

        expect(h.notesOf("user_b")).toBe("não me toques");
    });
});
