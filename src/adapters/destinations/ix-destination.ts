import type {
  DestinationAdapter,
  AdapterCtx,
  DestinationInvoiceCreateResult,
  DestinationCreditResult,
  NormalizedRefund,
} from "../types";
import type { Normalized } from "../../api/normalize-shopify";
import { IxApi } from "../../api/ix";
import { IxBuilder, type IxCreditNote } from "../../ix/builder";

function ixHeadersFromCtx(ctx: AdapterCtx) {
  return {
    "x-account-name": ctx.config.ix_account_name!,
    "x-api-key": ctx.config.ix_api_key!,
    "x-env": ctx.config.ix_environment === "production" ? "prod" as const : "dev" as const,
  };
}

function ixDocType(ctx: AdapterCtx) {
  return ctx.config.ix_document_type === "invoice_receipt" ? "invoice_receipt" as const : "invoice" as const;
}

export class InvoiceXpressDestination implements DestinationAdapter {
  readonly kind = "invoicexpress" as const;

  async findByReference(reference: string, ctx: AdapterCtx) {
    const res = await IxApi.v2.documents.reference.post({
      headers: ixHeadersFromCtx(ctx),
      body: { reference },
    });
    const id = res.data?.data?.id;
    return id ? { id: String(id) } : null;
  }

  async createDraft(normalized: Normalized, ctx: AdapterCtx): Promise<DestinationInvoiceCreateResult> {
    const builder = new IxBuilder(ctx.config);
    const { invoice } = builder.createInvoiceFromNormalizedOrder(normalized);

    const res = await IxApi.v2.documents.post({
      headers: ixHeadersFromCtx(ctx),
      body: { data: invoice, type: ixDocType(ctx) },
      query: { resolvers: "on_tax_fallback_search_tax_by_value" },
    });

    const id = res.data?.data?.id;
    if (!id) {
      const detail = JSON.stringify({ body: res.data, error: res.error });
      throw new Error(`InvoiceXpress create failed: ${detail.slice(0, 500)}`);
    }
    return { invoiceId: String(id) };
  }

  async finalize(invoiceId: string, ctx: AdapterCtx): Promise<void> {
    const { error } = await IxApi.v2.changeState.post({
      body: { type: ixDocType(ctx), id: Number(invoiceId), state: "finalized" },
      headers: ixHeadersFromCtx(ctx),
    });
    if (error) throw new Error(`InvoiceXpress finalize failed: ${JSON.stringify(error)}`);
  }

  async issueCredit(invoiceId: string, refund: NormalizedRefund, normalized: Normalized, ctx: AdapterCtx): Promise<DestinationCreditResult> {
    const builder = new IxBuilder(ctx.config);
    const { invoice } = builder.createInvoiceFromNormalizedOrder(normalized);

    const refundItems = normalized.order.items.filter(item => refund.itemsIds.includes(item.id));
    const items = builder.buildInvoiceItems(refundItems);

    if (refund.amountToRefund > 0) {
      const taxes = invoice.items.map(i => i.tax);
      const maxTax = taxes.reduce((a, b) =>
        (typeof a === "number" ? a : a.value) >= (typeof b === "number" ? b : b.value) ? a : b
      ) ?? 0;
      const taxPercentage = (typeof maxTax === "number" ? maxTax : maxTax.value) / 100;

      items.push({
        quantity: 1,
        tax: maxTax,
        unit_price: refund.amountToRefund / (1 + taxPercentage),
        description: `Refund amount of ${refund.amountToRefund}`,
        name: `Refund amount (#${refund.refundId})`,
      });
    }

    const requireTaxExemption = items.some(i =>
      typeof i.tax === "number" ? i.tax === 0 : i.tax.value === 0
    );

    const creditNote: IxCreditNote = {
      ...invoice,
      items,
      reference: `OrderRefund #${refund.refundId}`,
      tax_exemption_reason: requireTaxExemption ? ctx.config.ix_exemption_reason ?? undefined : undefined,
      owner_invoice_id: Number(invoiceId),
    };

    const { data, error } = await IxApi.v2.creditNotes.post({
      headers: ixHeadersFromCtx(ctx),
      body: { credit_note: creditNote },
      query: { resolvers: "on_tax_fallback_search_tax_by_value" },
    });
    if (error) throw new Error(`InvoiceXpress credit create failed: ${JSON.stringify(error)}`);

    const creditId = (data?.data as any)?.id
      ?? (data?.data as any)?.credit_note?.id
      ?? (data?.data as any)?.creditNote?.id;
    if (!creditId) throw new Error("InvoiceXpress credit returned no id");

    await IxApi.v2.changeState.post({
      body: { type: "credit_note", id: Number(creditId), state: "finalized" },
      headers: ixHeadersFromCtx(ctx),
    });

    return { creditId: String(creditId) };
  }

  async emailDocument(invoiceId: string, ctx: AdapterCtx): Promise<void> {
    const { data: invoiceData, error: getError } = await IxApi.v2.documents.byId.get({
      headers: ixHeadersFromCtx(ctx),
      path: { id: Number(invoiceId) },
    });
    if (getError) throw new Error(`InvoiceXpress fetch failed: ${JSON.stringify(getError)}`);

    if (!invoiceData.data.client.email) return;

    const { error } = await IxApi.v2.documents.byId.email.post({
      body: {
        message: {
          client: { email: invoiceData.data.client.email, save: "0" },
          body: ctx.config.ix_email_body ?? undefined,
          subject: ctx.config.ix_email_subject ?? undefined,
        },
      },
      path: { id: Number(invoiceId) },
      query: { type: ctx.config.ix_document_type === "invoice_receipt" ? "invoice_receipts" : "invoices" },
      headers: ixHeadersFromCtx(ctx),
    });
    if (error) throw new Error(`InvoiceXpress email failed: ${JSON.stringify(error)}`);
  }
}
