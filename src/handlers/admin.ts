import type { Env } from "../env";
import type { IRequestConfig } from "../storage";
import { AppStorage } from "../storage";
import { Shopify } from "../shopify";
import { IxApi } from "../api/ix";
import { IxBuilder } from "../ix/builder";

interface ShopifyOrderSummary {
  id: number;
  order_number: number;
  name: string;
  created_at: string;
  financial_status: string;
  fulfillment_status: string | null;
  total_price: string;
  customer_name: string | null;
  customer_email: string | null;
  note: string | null;
}

type OrderResult = {
  order_id: number;
  order_number: number;
  status: "created" | "finalized" | "skipped" | "error";
  message: string;
};

async function fetchShopifyOrders(config: IRequestConfig, from: string, to: string): Promise<any[]> {
  const allOrders: any[] = [];
  const apiVersion = config.shopify_api_version ?? "2026-01";
  let url: string | null = `https://${config.shopify_domain}/admin/api/${apiVersion}/orders.json?processed_at_min=${encodeURIComponent(from)}&processed_at_max=${encodeURIComponent(to)}&status=any&limit=250`;

  while (url) {
    const response = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": config.shopify_token!,
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Shopify API error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as { orders: any[] };
    allOrders.push(...data.orders);

    // Handle pagination via Link header
    const linkHeader = response.headers.get("Link");
    url = null;
    if (linkHeader) {
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (nextMatch) {
        url = nextMatch[1];
      }
    }
  }

  return allOrders;
}

function summarizeOrder(order: any): ShopifyOrderSummary {
  return {
    id: order.id,
    order_number: order.order_number,
    name: order.name,
    created_at: order.created_at,
    financial_status: order.financial_status,
    fulfillment_status: order.fulfillment_status,
    total_price: order.total_price,
    customer_name: order.customer
      ? `${order.customer.first_name ?? ""} ${order.customer.last_name ?? ""}`.trim() || null
      : null,
    customer_email: order.customer?.email ?? null,
    note: order.note,
  };
}

export async function getUnprocessedOrders(env: Env, config: IRequestConfig, from: string, to: string) {
  const appStorage = new AppStorage(env, config.shopify_domain!);

  const shopifyOrders = await fetchShopifyOrders(config, from, to);
  const orderIds = shopifyOrders.map((o) => String(o.id));
  const processedIds = await appStorage.getProcessedOrderIds(orderIds);

  const notInDb = shopifyOrders.filter((o) => !processedIds.has(String(o.id)));

  // Also check InvoiceXpress by reference to filter out orders that exist there but not in our DB
  const ixHeaders = {
    "x-account-name": config.ix_account_name!,
    "x-api-key": config.ix_api_key!,
    "x-env": config.ix_environment === "production" ? "prod" as const : "dev" as const,
  };

  const unprocessed: any[] = [];
  const existsInIx: any[] = [];

  for (const order of notInDb) {
    const ixRef = `Order #${order.order_number}`;
    const ixExisting = await IxApi.v2.documents.reference.post({
      headers: ixHeaders,
      body: { reference: ixRef },
    });

    if (ixExisting.data?.data?.id) {
      // Exists in IX but not in our DB — sync it
      await appStorage.saveProcessedInvoice(String(order.id), String(ixExisting.data.data.id));
      existsInIx.push(order);
    } else {
      unprocessed.push(order);
    }
  }

  return {
    total_shopify_orders: shopifyOrders.length,
    processed_count: processedIds.size,
    exists_in_ix_synced: existsInIx.length,
    unprocessed_count: unprocessed.length,
    unprocessed: unprocessed.map(summarizeOrder),
  };
}

export async function processOrders(
  env: Env,
  config: IRequestConfig,
  type: "create_orders" | "finalize_orders",
  orderIds: number[] | undefined,
  from?: string,
  to?: string
) {
  let orders: any[];

  if (orderIds && orderIds.length > 0) {
    // Fetch specific orders by ID from Shopify
    orders = await fetchOrdersByIds(config, orderIds);
  } else if (from && to) {
    // Fetch unprocessed orders from date range
    const appStorage = new AppStorage(env, config.shopify_domain!);
    const shopifyOrders = await fetchShopifyOrders(config, from, to);
    const allIds = shopifyOrders.map((o) => String(o.id));
    const processedIds = await appStorage.getProcessedOrderIds(allIds);

    if (type === "create_orders") {
      // For create: only unprocessed (not in DB)
      orders = shopifyOrders.filter((o) => !processedIds.has(String(o.id)));
    } else {
      // For finalize: only processed (in DB, have invoice)
      orders = shopifyOrders.filter((o) => processedIds.has(String(o.id)));
    }
  } else {
    throw new Error("Either order_ids or from/to date range is required");
  }

  const results: OrderResult[] = [];

  for (const order of orders) {
    if (type === "create_orders") {
      results.push(await adminCreateOrder(env, config, order));
    } else {
      results.push(await adminFinalizeOrder(env, config, order));
    }
  }

  return {
    type,
    total: results.length,
    success: results.filter((r) => r.status === "created" || r.status === "finalized").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    errors: results.filter((r) => r.status === "error").length,
    results,
  };
}

async function fetchOrdersByIds(config: IRequestConfig, orderIds: number[]): Promise<any[]> {
  const apiVersion = config.shopify_api_version ?? "2026-01";
  const ids = orderIds.join(",");
  const url = `https://${config.shopify_domain}/admin/api/${apiVersion}/orders.json?ids=${ids}&status=any&limit=250`;

  const response = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": config.shopify_token!,
      "Accept": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Shopify API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json() as { orders: any[] };
  return data.orders;
}

async function adminCreateOrder(env: Env, config: IRequestConfig, order: any): Promise<OrderResult> {
  const appStorage = new AppStorage(env, config.shopify_domain!);
  const orderId = String(order.id);

  try {
    // Check if already processed
    const alreadyExists = await appStorage.isInvoiceAlreadyProcessed(orderId);
    if (alreadyExists) {
      return { order_id: order.id, order_number: order.order_number, status: "skipped", message: "Already processed in DB" };
    }

    const ixRef = `Order #${order.order_number}`;
    const ixHeaders = {
      "x-account-name": config.ix_account_name!,
      "x-api-key": config.ix_api_key!,
      "x-env": config.ix_environment === "production" ? "prod" as const : "dev" as const,
    };

    // Check if invoice already exists in InvoiceXpress
    const ixExisting = await IxApi.v2.documents.reference.post({
      headers: ixHeaders,
      body: { reference: ixRef },
    });

    if (ixExisting.data?.data?.id) {
      // Exists in IX but not in our DB — save the reference
      await appStorage.saveProcessedInvoice(orderId, String(ixExisting.data.data.id));
      return { order_id: order.id, order_number: order.order_number, status: "skipped", message: `Already exists in InvoiceXpress (id=${ixExisting.data.data.id}), synced to DB` };
    }

    // Normalize order
    const shopify = new Shopify(env.NORMALIZE_SHOPIFY_ORDER_API_KEY, config);
    const normalizedOrderResponse = await shopify.normalizeOrder(orderId);

    if (!normalizedOrderResponse) {
      return { order_id: order.id, order_number: order.order_number, status: "error", message: "Failed to normalize order" };
    }

    const ixBuilder = new IxBuilder(config);
    const { invoice } = ixBuilder.createInvoiceFromNormalizedOrder(normalizedOrderResponse.normalized);

    const ixCreateResponse = await IxApi.v2.documents.post({
      headers: ixHeaders,
      body: {
        data: invoice,
        type: config.ix_document_type === "invoice_receipt" ? "invoice_receipt" : "invoice",
      },
      query: {
        resolvers: "on_tax_fallback_search_tax_by_value",
      },
    });

    if (ixCreateResponse.data?.data?.id) {
      await appStorage.saveProcessedInvoice(orderId, String(ixCreateResponse.data.data.id));
      return { order_id: order.id, order_number: order.order_number, status: "created", message: `Invoice ${ixCreateResponse.data.data.id} created` };
    }

    return { order_id: order.id, order_number: order.order_number, status: "error", message: `IX API returned no id: ${JSON.stringify(ixCreateResponse.error ?? ixCreateResponse.data)}` };
  } catch (e) {
    return { order_id: order.id, order_number: order.order_number, status: "error", message: String(e) };
  }
}

async function adminFinalizeOrder(env: Env, config: IRequestConfig, order: any): Promise<OrderResult> {
  const appStorage = new AppStorage(env, config.shopify_domain!);
  const orderId = String(order.id);

  try {
    const invoiceRef = await appStorage.getInvoiceByOrderId(orderId);
    if (!invoiceRef) {
      return { order_id: order.id, order_number: order.order_number, status: "skipped", message: "No invoice found in DB — run create_orders first" };
    }

    const ixHeaders = {
      "x-account-name": config.ix_account_name!,
      "x-api-key": config.ix_api_key!,
      "x-env": config.ix_environment === "production" ? "prod" as const : "dev" as const,
    };

    // Finalize the invoice
    const { data, error } = await IxApi.v2.changeState.post({
      body: {
        type: config.ix_document_type === "invoice_receipt" ? "invoice_receipt" : "invoice",
        id: Number(invoiceRef.invoice_id),
        state: "finalized",
      },
      headers: ixHeaders,
    });

    if (error) {
      return { order_id: order.id, order_number: order.order_number, status: "error", message: `Finalize failed: ${JSON.stringify(error)}` };
    }

    // Send email if configured
    if (config.ix_send_email) {
      const { data: invoiceData, error: invoiceError } = await IxApi.v2.documents.byId.get({
        headers: ixHeaders,
        path: { id: Number(invoiceRef.invoice_id) },
      });

      if (!invoiceError && invoiceData?.data?.client?.email && invoiceData?.data?.client?.fiscal_id) {
        await IxApi.v2.documents.byId.email.post({
          body: {
            message: {
              client: {
                email: invoiceData.data.client.email,
                save: "0",
              },
              body: config.ix_email_body ?? undefined,
              subject: config.ix_email_subject ?? undefined,
            },
          },
          path: { id: Number(invoiceRef.invoice_id) },
          query: {
            type: config.ix_document_type === "invoice_receipt" ? "invoice_receipts" : "invoices",
          },
          headers: ixHeaders,
        });
      }
    }

    return { order_id: order.id, order_number: order.order_number, status: "finalized", message: `Invoice ${invoiceRef.invoice_id} finalized` };
  } catch (e) {
    return { order_id: order.id, order_number: order.order_number, status: "error", message: String(e) };
  }
}
