import { describe, it, expect } from "vitest";
import {
  accountName,
  accountLabel,
  accountIdentityLine,
  realName,
  REAL_NAME_SQL,
  ACCOUNT_LABEL_SQL,
  resolveAccountIdentity,
} from "./account-label";

// The row that produced the screenshot: a real company, and a `name` column the
// Clerk webhook defaulted to "User".
const BESTISAFIL = {
  id: "user_3J86x6WeWPuLoijLUXt1Mt0La6z",
  name: "User",
  company_name: "Bestisafil lda",
  admin_label: "Bestisafil",
  email: "matilde@bestisafil.com",
  client_code: "RIO-D97EC7",
};

describe("account label", () => {
  it("never lets the Clerk placeholder be a name", () => {
    expect(realName("User")).toBeUndefined();
    expect(realName(" user ")).toBeUndefined();
    expect(realName("Utilizador")).toBeUndefined();
    expect(realName("Stephen Hall")).toBe("Stephen Hall");
    // A real name that merely contains it is still a name.
    expect(realName("User Experience Lda")).toBe("User Experience Lda");
  });

  it("labels the account that was printing 'User'", () => {
    expect(accountLabel(BESTISAFIL)).toBe("Bestisafil");
  });

  it("falls through to company, then person, then email", () => {
    expect(accountName({ company_name: "Janis Rio Lda", name: "User" })).toBe("Janis Rio Lda");
    expect(accountName({ company_name: "", name: "Stephen Hall" })).toBe("Stephen Hall");
    // Nothing registered: accountName says so, accountLabel substitutes.
    expect(accountName({ name: "User", email: "a@b.pt" })).toBeUndefined();
    expect(accountLabel({ name: "User", email: "a@b.pt" })).toBe("a@b.pt");
    // The caller's fallback outranks the raw id, and the id is the last resort.
    expect(accountLabel({ id: "user_x" }, "a sua conta")).toBe("a sua conta");
    expect(accountLabel({ id: "user_x" })).toBe("user_x");
  });

  it("puts the name first and the number second", () => {
    expect(accountIdentityLine({ label: "Bestisafil", code: "RIO-D97EC7" }))
      .toBe("Bestisafil · RIO-D97EC7");
    expect(accountIdentityLine({ label: "Bestisafil" })).toBe("Bestisafil");
    expect(accountIdentityLine(undefined)).toBeUndefined();
  });

  it("keeps the SQL and the TS precedence in step", () => {
    // Same three columns, same order, and the placeholder guarded in both.
    const sql = ACCOUNT_LABEL_SQL("u");
    expect(sql.indexOf("admin_label")).toBeLessThan(sql.indexOf("company_name"));
    expect(sql.indexOf("company_name")).toBeLessThan(sql.indexOf("u.name"));
    expect(REAL_NAME_SQL("u")).toContain("'user'");
  });

  it("resolves a live account to its label and its number", async () => {
    const env: any = {
      DB: {
        prepare: () => ({ bind: () => ({ first: async () => BESTISAFIL }) }),
      },
    };
    expect(await resolveAccountIdentity(env, "user_x")).toEqual({
      label: "Bestisafil",
      code: "RIO-D97EC7",
    });
    expect(await resolveAccountIdentity(env, null)).toBeUndefined();
  });

  it("renders an email rather than failing when the lookup throws", async () => {
    const env: any = { DB: { prepare: () => { throw new Error("D1 down"); } } };
    expect(await resolveAccountIdentity(env, "user_x")).toBeUndefined();
  });
});
