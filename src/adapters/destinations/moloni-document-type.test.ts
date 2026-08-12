import { describe, it, expect } from "vitest";
import {
  moloniPath,
  moloniPathsWithFallback,
  simplifiedInvoiceBlocker,
  SIMPLIFIED_INVOICE_MAX_TOTAL,
} from "./moloni-destination";

describe("moloniPath", () => {
  it("maps each document type to its own endpoint family", () => {
    expect(moloniPath({ documentType: "invoice" }, "insert")).toBe("/invoices/insert/");
    expect(moloniPath({ documentType: "invoice_receipt" }, "insert")).toBe("/invoiceReceipts/insert/");
    expect(moloniPath({ documentType: "simplified_invoice" }, "insert")).toBe("/simplifiedInvoices/insert/");
  });

  it("keeps insert and update in the same family", () => {
    // Moloni scopes document_id per collection: updating a simplified invoice
    // through /invoices/update/ 404s the id and auto-finalize fails silently.
    for (const documentType of ["invoice", "invoice_receipt", "simplified_invoice"]) {
      const insert = moloniPath({ documentType }, "insert");
      const update = moloniPath({ documentType }, "update");
      expect(update).toBe(insert.replace("/insert/", "/update/"));
    }
  });

  it("falls back to plain invoice for unknown or absent types", () => {
    expect(moloniPath({ documentType: "receipt" }, "insert")).toBe("/invoices/insert/");
    expect(moloniPath({ documentType: "" }, "insert")).toBe("/invoices/insert/");
  });

  it("is case-insensitive", () => {
    expect(moloniPath({ documentType: "Simplified_Invoice" }, "getAll")).toBe("/simplifiedInvoices/getAll/");
  });
});

describe("moloniPathsWithFallback", () => {
  it("probes the configured type first, then the others", () => {
    expect(moloniPathsWithFallback({ documentType: "invoice_receipt" }, "getOne")).toEqual([
      "/invoiceReceipts/getOne/",
      "/invoices/getOne/",
      "/simplifiedInvoices/getOne/",
    ]);
  });

  it("covers every type so a re-typed connection can still find old documents", () => {
    expect(moloniPathsWithFallback({ documentType: "simplified_invoice" }, "getOne")).toHaveLength(3);
    expect(moloniPathsWithFallback({ documentType: "simplified_invoice" }, "getOne")[0])
      .toBe("/simplifiedInvoices/getOne/");
  });
});

describe("simplifiedInvoiceBlocker", () => {
  it("allows a small anonymous sale", () => {
    expect(simplifiedInvoiceBlocker(120.5, null)).toBeNull();
    expect(simplifiedInvoiceBlocker(SIMPLIFIED_INVOICE_MAX_TOTAL, null)).toBeNull();
  });

  it("blocks above the art. 40 CIVA cap", () => {
    expect(simplifiedInvoiceBlocker(SIMPLIFIED_INVOICE_MAX_TOTAL + 0.01, null)).toBe("over_cap");
  });

  it("blocks when the buyer gave a NIF", () => {
    expect(simplifiedInvoiceBlocker(50, "123456789")).toBe("has_nif");
  });

  it("treats an unreadable total as a blocker, not as under the cap", () => {
    expect(simplifiedInvoiceBlocker(Number.NaN, null)).toBe("unknown_total");
  });

  it("reports the cap before the NIF when both apply", () => {
    expect(simplifiedInvoiceBlocker(5000, "123456789")).toBe("over_cap");
  });
});
