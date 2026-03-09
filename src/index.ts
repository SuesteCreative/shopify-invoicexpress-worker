import { Env, isIdempotent, markAsInvoiced, getConfig, saveLog } from "./storage";
import { verifyShopifyWebhook } from "./shopify";
import { extractAndValidateNIF } from "./nif";
import {
  getOrCreateClient,
  createDocument,
  findDocumentDetailsByReference,
  findCreditNoteByReference,
  createCreditNote
} from "./invoicexpress";

function mapClientMetadata(order: any, config: Env) {
  const nif = extractAndValidateNIF(order);
  const firstName = (order.customer?.first_name || "").trim();
  const lastName = (order.customer?.last_name || "").trim();
  const billingName = (order.billing_address?.name || "").trim();
  const email = (order.customer?.email || order.email || "").trim();

  const resolvedName = `${firstName} ${lastName}`.trim() || billingName;
  const isPosMode = config.POS_MODE === "1";

  let name: string;

  if (isPosMode) {
    // POS mode: full fiscal name matrix (only for clients like Benedita using POS without customer names)
    // 1. Real name → use it
    // 2. No name + NIF → "NIF XXXXXXXXX" (unique fiscal identifier, re-usable across purchases)
    // 3. No name + email → email username
    // 4. Nothing → "Consumidor Final"
    if (resolvedName) {
      name = resolvedName;
    } else if (nif) {
      name = `NIF ${nif}`;
    } else if (email) {
      name = email.split("@")[0].replace(/[._-]/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
    } else {
      name = "Consumidor Final";
    }
  } else {
    // Standard mode: Use real name if available.
    // Special case: if no NIF is provided, and the name is generic/missing, use "Consumidor Final"
    const isGeneric = !resolvedName || ["client", "unknown"].includes(resolvedName.toLowerCase());
    if (!nif && isGeneric) {
      name = "Consumidor Final";
    } else {
      name = resolvedName || "Consumidor Final";
    }
  }

  // Country mapping: InvoiceXpress expects exact country names from its catalog.
  const countryMap: Record<string, string> = {
    "PT": "Portugal",
    "PT-AC": "Portugal",
    "PT-MA": "Portugal",
    "AF": "Afghanistan",
    "AX": "Åland Islands",
    "AL": "Albania",
    "DZ": "Algeria",
    "AS": "Samoa (America)",
    "AD": "Andorra",
    "AO": "Angola",
    "AI": "Anguilla",
    "AQ": "Dronning Maud Land",
    "AG": "Antigua and Barbuda",
    "AR": "Argentina",
    "AM": "Armenia",
    "AW": "Aruba",
    "AU": "Australia",
    "AT": "Austria",
    "AZ": "Azerbaijan",
    "BS": "Bahamas",
    "BH": "Bahrain",
    "BD": "Bangladesh",
    "BB": "Barbados",
    "BY": "Belarus",
    "BE": "Belgium",
    "BZ": "Belize",
    "BJ": "Benin",
    "BM": "Bermuda",
    "BT": "Bhutan",
    "BO": "Bolivia",
    "BA": "Bosnia-Herzegovina",
    "BW": "Botswana",
    "BV": "Bouvet Island",
    "BR": "Brazil",
    "IO": "British Indian Ocean Territory",
    "BN": "Brunei",
    "BG": "Bulgaria",
    "BF": "Upper Volta",
    "MM": "Myanmar",
    "BI": "Burundi",
    "KH": "Kampuchea",
    "CM": "Cameroon",
    "CA": "Canada",
    "KI": "Canton and Enderbury Islands",
    "CV": "Cape Verde",
    "KY": "Cayman Islands",
    "CF": "Central African Republic",
    "TD": "Chad",
    "CL": "Chile",
    "CN": "China",
    "CX": "Christmas Island",
    "CC": "Cocos (Keeling) Islands",
    "CO": "Colombia",
    "KM": "Comoros",
    "CG": "Congo",
    "CD": "Zaïre",
    "CK": "Cook Islands",
    "CR": "Costa Rica",
    "CI": "Ivory Coast",
    "HR": "Croatia",
    "CU": "Cuba",
    "CY": "Cyprus",
    "CZ": "Czech Republic",
    "DK": "Denmark",
    "DJ": "Djibouti",
    "DM": "Dominica",
    "DO": "Dominican Republic",
    "TL": "Timor-Leste",
    "EC": "Ecuador",
    "EG": "Egypt",
    "SV": "El Salvador",
    "GQ": "Equatorial Guinea",
    "ER": "Eritrea",
    "EE": "Estonia",
    "ET": "Ethiopia",
    "FK": "Falkland Islands",
    "FO": "Faroe Islands",
    "FJ": "Fiji",
    "FI": "Finland",
    "FR": "France",
    "GF": "French Guiana",
    "PF": "Tahiti",
    "TF": "French Southern Territories",
    "GA": "Gabon",
    "GM": "Gambia",
    "GE": "Georgia",
    "DE": "Germany",
    "GH": "Ghana",
    "GI": "Gibraltar",
    "GR": "Greece",
    "GL": "Greenland",
    "GD": "Grenada",
    "GP": "Guadeloupe",
    "GU": "Guam",
    "GT": "Guatemala",
    "GG": "Guernsey",
    "GN": "Guinea",
    "GW": "Guinea-Bissau",
    "GY": "Guyana",
    "HT": "Haiti",
    "HM": "Heard and McDonald Islands",
    "VA": "Vatican",
    "HN": "Honduras",
    "HK": "Hong Kong",
    "HU": "Hungary",
    "IS": "Iceland",
    "IN": "India",
    "ID": "Indonesia",
    "IR": "Iran",
    "IQ": "Iraq",
    "IE": "Ireland",
    "IM": "Isle of Man",
    "IL": "Israel",
    "IT": "Italy",
    "JM": "Jamaica",
    "JP": "Japan",
    "JE": "Jersey",
    "UM": "Wake Island",
    "JO": "Jordan",
    "KZ": "Kazakhstan",
    "KE": "Kenya",
    "KP": "Korea, North",
    "KR": "Korea, South",
    "KW": "Kuwait",
    "KG": "Kyrgyzstan",
    "LA": "Laos",
    "LV": "Latvia",
    "LB": "Lebanon",
    "LS": "Lesotho",
    "LR": "Liberia",
    "LY": "Libya",
    "LI": "Liechtenstein",
    "LT": "Lithuania",
    "LU": "Luxembourg",
    "MO": "Macau",
    "MK": "Macedonia",
    "MG": "Madagascar",
    "MW": "Malawi",
    "MY": "Malaysia",
    "MV": "Maldives",
    "ML": "Mali",
    "MT": "Malta",
    "MH": "Marshall Islands",
    "MQ": "Martinique",
    "MR": "Mauritania",
    "MU": "Mauritius",
    "YT": "Mayotte",
    "MX": "Mexico",
    "FM": "Micronesia",
    "MD": "Moldova",
    "MC": "Monaco",
    "MN": "Mongolia",
    "ME": "Montenegro",
    "MS": "Montserrat",
    "MA": "Morocco",
    "MZ": "Mozambique",
    "NA": "Namibia",
    "NR": "Nauru",
    "NP": "Nepal",
    "NL": "Netherlands",
    "AN": "Netherlands Antilles",
    "NC": "New Caledonia",
    "NZ": "New Zealand",
    "NI": "Nicaragua",
    "NE": "Niger",
    "NG": "Nigeria",
    "NU": "Niue",
    "NF": "Norfolk Island",
    "MP": "Northern Mariana Islands",
    "NO": "Norway",
    "OM": "Oman",
    "PK": "Pakistan",
    "PW": "Palau",
    "PS": "Palestine",
    "PA": "Panama",
    "PG": "Papua New Guinea",
    "PY": "Paraguay",
    "PE": "Peru",
    "PH": "Philippines",
    "PN": "Pitcairn Island",
    "PL": "Poland",
    "PR": "Puerto Rico",
    "QA": "Qatar",
    "RE": "Reunion",
    "RO": "Romania",
    "RU": "Russian Federation",
    "RW": "Rwanda",
    "BL": "Saint Barthélemy",
    "SH": "St. Helena",
    "KN": "St. Kitts and Nevis",
    "LC": "St. Lucia",
    "MF": "Saint Martin",
    "PM": "Saint Pierre And Miquelon",
    "VC": "St. Vincent and the Grenadines",
    "WS": "Western Samoa",
    "SM": "San Marino",
    "ST": "São Tomé and Príncipe",
    "SA": "Saudi Arabia",
    "SN": "Sénégal",
    "RS": "Serbia",
    "SC": "Seychelles",
    "SL": "Sierra Leone",
    "SG": "Singapore",
    "SK": "Slovakia",
    "SI": "Slovenia",
    "SB": "Solomon Islands",
    "SO": "Somalia",
    "ZA": "South Africa",
    "GS": "South Georgia And The South Sandwich Islands",
    "ES": "Spain",
    "LK": "Sri Lanka",
    "SD": "Sudan",
    "SR": "Suriname",
    "SJ": "Svalbard and Jan Mayen Islands",
    "SZ": "Swaziland",
    "SE": "Sweden",
    "CH": "Switzerland",
    "SY": "Syria",
    "TW": "Taiwan",
    "TJ": "Tajikistan",
    "TZ": "Tanzania",
    "TH": "Thailand",
    "TG": "Togo",
    "TK": "Tokelau",
    "TO": "Tonga",
    "TT": "Trinidad and Tobago",
    "TN": "Tunisia",
    "TR": "Turkey",
    "TM": "Turkmenistan",
    "TC": "Turks and Caicos Islands",
    "TV": "Tuvalu",
    "UG": "Uganda",
    "UA": "Ukraine",
    "AE": "United Arab Emirates",
    "GB": "United Kingdom",
    "US": "United States",
    "UY": "Uruguay",
    "UZ": "Uzbekistan",
    "VU": "Vanuatu",
    "VE": "Venezuela",
    "VN": "Vietnam",
    "VG": "Virgin Islands",
    "VI": "Virgin Islands, U.S.",
    "WF": "Wallis and Futuna Islands",
    "EH": "Western Sahara",
    "YE": "Yemen",
    "ZM": "Zambia",
    "ZW": "Zimbabwe"
  };

  const countryAliases: Record<string, string> = {
    "PORTUGAL - CONTINENTAL": "Portugal",
    "PORTUGAL – CONTINENTAL": "Portugal",
    "PORTUGAL - AÇORES": "Portugal",
    "PORTUGAL – AÇORES": "Portugal",
    "PORTUGAL - MADEIRA": "Portugal",
    "PORTUGAL – MADEIRA": "Portugal"
  };

  const rawCountry = String(order.billing_address?.country_code || order.billing_address?.country || "").trim();
  const upperCountry = rawCountry.toUpperCase();
  const country = countryMap[upperCountry] || countryAliases[upperCountry] || rawCountry;

  return {
    name,
    email,
    fiscal_id: nif,
    code: String(order.customer?.id || order.id),
    address: order.billing_address?.address1,
    city: order.billing_address?.city,
    zip: order.billing_address?.zip,
    country: country,
    phone: order.customer?.phone || order.billing_address?.phone
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Load Dynamic Config from D1 (fallback to wrangler.toml if not found)
    const config = await getConfig(request, env);

    // 1. Health check
    if (url.pathname === "/health" && request.method === "GET") {
      return new Response("OK", { status: 200 });
    }

    // 2. Webhook handler: Order Paid
    if (url.pathname === "/webhooks/shopify/orders-paid" && request.method === "POST") {
      const shopHeader = request.headers.get("X-Shopify-Shop-Domain");
      console.log(`[Rioko] Webhook Received: orders-paid for ${shopHeader}`);

      const isValid = await verifyShopifyWebhook(request, config.SHOPIFY_WEBHOOK_SECRET);
      if (!isValid) {
        console.error(`[Rioko] Invalid Webhook Signature for ${config.SHOPIFY_SHOP_DOMAIN}.`);
        await saveLog(env, { shopify_domain: shopHeader, topic: "orders/paid", payload: "HIDDEN", response: "Invalid Signature", status: 401 });
        return new Response("Invalid Signature", { status: 401 });
      }

      const order = await request.clone().json<any>();
      const orderId = order.id;

      try {
        const existing = await isIdempotent(orderId, config);
        if (existing) {
          await saveLog(env, { shopify_domain: shopHeader, topic: "orders/paid", payload: orderId, response: "Already invoiced", status: 200 });
          return new Response(JSON.stringify({ message: "already invoiced" }), { status: 200 });
        }

        // Anti-duplication check: Check IX directly
        const ixRef = `Order #${order.order_number}`;
        const ixExisting = await findDocumentDetailsByReference(config, ixRef);
        if (ixExisting) {
          console.log(`[IX] Document already exists in IX: ${ixExisting.id}`);
          const clientMetadata = mapClientMetadata(order, config);
          const clientId = await getOrCreateClient(config, clientMetadata);
          await markAsInvoiced(order.id, ixExisting.id, config, { clientId, clientMetadata, orderNumber: order.order_number });
          await saveLog(env, { shopify_domain: shopHeader, topic: "orders/paid", payload: orderId, response: { message: "Already existed in IX", invoice_id: ixExisting.id }, status: 200 });
          return new Response(JSON.stringify({ message: "Already existed in IX", invoice_id: ixExisting.id }), { status: 200 });
        }

        const clientMetadata = mapClientMetadata(order, config);
        const clientId = await getOrCreateClient(config, clientMetadata);

        // Create Document (Type and Sequence handled by config)
        const invoiceId = await createDocument(config, clientId, order, clientMetadata);

        await markAsInvoiced(orderId, invoiceId, config, { clientId, clientMetadata, orderNumber: order.order_number });
        await saveLog(env, { shopify_domain: shopHeader, topic: "orders/paid", payload: orderId, response: { invoiceId }, status: 200 });

        return new Response(JSON.stringify({ message: "Fatura-Recibo created", invoice_id: invoiceId }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      } catch (error: any) {
        console.error(`Error processing order ${orderId}:`, error.message);
        await saveLog(env, { shopify_domain: shopHeader, topic: "orders/paid", payload: orderId, response: error.message, status: 500 });
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
      }
    }

    // 3. Webhook handler: Refund Created
    if (url.pathname === "/webhooks/shopify/refunds-create" && request.method === "POST") {
      const shopHeader = request.headers.get("X-Shopify-Shop-Domain");
      console.log(`[Rioko] Webhook Received: refunds-create for ${shopHeader}`);

      const isValid = await verifyShopifyWebhook(request, config.SHOPIFY_WEBHOOK_SECRET);
      if (!isValid) {
        await saveLog(env, { shopify_domain: shopHeader, topic: "refunds/create", payload: "HIDDEN", response: "Invalid Signature", status: 401 });
        return new Response("Invalid Signature", { status: 401 });
      }

      const refund = await request.clone().json<any>();
      const refundId = refund.id;
      const orderId = refund.order_id;

      // Idempotency for refunds
      const existing = await isIdempotent(`refund_${refundId}`, config);
      if (existing) {
        await saveLog(env, { shopify_domain: shopHeader, topic: "refunds/create", payload: refundId, response: "Refund already processed", status: 200 });
        return new Response("Refund already processed", { status: 200 });
      }

      try {
        // 3. Check for stored metadata in KV (Privacy-First Mapping)
        const kvDataRaw = await isIdempotent(orderId, config);
        let clientId, clientMetadata, orderNumber;

        if (kvDataRaw) {
          const kvData = JSON.parse(kvDataRaw);
          clientId = kvData.clientId;
          clientMetadata = kvData.clientMetadata;
          orderNumber = kvData.orderNumber;
        }

        if (!clientId || !clientMetadata) {
          console.log(`[Memory] No metadata found in KV for Order ${orderId}. Falling back to Shopify API...`);
          // Original fallback (might fail with 401 if missing permissions)
          const orderRes = await fetch(`https://${config.SHOPIFY_SHOP_DOMAIN}/admin/api/${config.SHOPIFY_API_VERSION}/orders/${orderId}.json`, {
            headers: { "X-Shopify-Access-Token": config.SHOPIFY_ACCESS_TOKEN }
          });

          if (!orderRes.ok) {
            const err = await orderRes.text();
            console.error(`[Shopify] Failed to fetch order ${orderId}: ${orderRes.status} - ${err}`);
            if (orderRes.status === 401 || orderRes.status === 403) {
              throw new Error("ACCESS_DENIED: Cannot fetch order details for refund. Ensure 'Protected Customer Data' is enabled OR make sure the order was placed AFTER the latest Rioko update.");
            }
            if (orderRes.status === 404) return new Response("Order not found, skipping", { status: 200 });
            throw new Error(`Shopify API Error: ${orderRes.status}`);
          }

          const data: any = await orderRes.json();
          const shopifyOrder = data.order;
          if (!shopifyOrder) throw new Error("Invalid order data from Shopify");

          clientId = await getOrCreateClient(config, mapClientMetadata(shopifyOrder, config));
          clientMetadata = mapClientMetadata(shopifyOrder, config);
          orderNumber = shopifyOrder.order_number;
        }

        console.log(`[Rioko] Using stored metadata for Refund. Client: ${clientMetadata.name}, Order: #${orderNumber}`);

        // Anti-duplication check for credit notes
        const refundRef = `Refund #${refundId} for Order #${orderNumber}`;
        const cxExisting = await findCreditNoteByReference(config, refundRef);
        if (cxExisting) {
          console.log(`[IX] Credit Note already exists for refund ${refundId}: ${cxExisting}`);
          await markAsInvoiced(`refund_${refundId}`, cxExisting, config);
          await saveLog(env, { shopify_domain: shopHeader, topic: "refunds/create", payload: refundId, response: { message: "Refund already in IX", credit_note_id: cxExisting }, status: 200 });
          return new Response(JSON.stringify({ message: "Refund already in IX", credit_note_id: cxExisting }), { status: 200 });
        }

        // Create Credit Note
        const originalRef = `Order #${orderNumber}`;
        const creditNoteId = await createCreditNote(config, clientId, originalRef, { order_number: orderNumber, id: orderId, ...refund }, refund, clientMetadata);

        await markAsInvoiced(`refund_${refundId}`, creditNoteId, config);
        await saveLog(env, { shopify_domain: shopHeader, topic: "refunds/create", payload: refundId, response: { creditNoteId }, status: 200 });

        return new Response(JSON.stringify({ message: "Credit Note created", credit_note_id: creditNoteId }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      } catch (error: any) {
        if (error.message === "DOCUMENT_IS_DRAFT") {
          console.log(`[HOLD] Original document for Order #${orderId} is still a Draft. Credit Note is on hold (Shopify will retry).`);
          await saveLog(env, { shopify_domain: shopHeader, topic: "refunds/create", payload: refundId, response: "HOLD: Original is Draft", status: 422 });
          return new Response(JSON.stringify({
            message: "HOLD: Original document is a Draft. Please finalize it in InvoiceXpress to allow Credit Note creation.",
            state: "waiting"
          }), { status: 422 });
        }
        console.error(`Error processing refund ${refundId}:`, error.message);
        await saveLog(env, { shopify_domain: shopHeader, topic: "refunds/create", payload: refundId, response: error.message, status: 500 });
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};
