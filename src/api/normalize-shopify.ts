export interface Root {
  shop: string
  order_id: string
  normalized: Normalized
}

export interface Normalized {
  order: Order
  refunds: Refund[]
  exchanges: any[]
  credits: Credit[]
  debits: any[]
}

export interface Order {
  id: number
  reference: string
  order_number: number
  created_at: string
  note: any
  note_attributes: any[]
  metafields: any
  tags: any[]
  meta: Meta
  total: number
  total_calculated: number
  currency: string
  shop_currency: string
  exchange_rate: number
  financial_status: string
  fulfillment_status: any
  customer: Customer
  billing_address: BillingAddress
  shipping_address: ShippingAddress
  items: Item[]
  global_discount: GlobalDiscount
}

export interface Meta {
  device_id: string | null
  token: string
  source_name: string
  browser_ip: string
  payment_gateway_names: string[]
  source_identifier: string | null
  confirmation_number: string
  processed_at: string
}

export interface Customer {
  id: number
  email: string
  name: string
  created_at: string
  default_address: DefaultAddress
  address: DefaultAddress
}

export interface DefaultAddress {
  first_name: string
  last_name: string
  name: string
  company: string | null
  address1: string
  address2: string
  city: string
  province: string
  province_code: string
  zip: string
  country: string
  country_code: string
  phone: string | null
}

export interface BillingAddress {
  first_name: string
  last_name: string
  name: string
  company: string | null
  address1: string
  address2: string
  city: string
  province: string
  province_code: string
  zip: string
  country: string
  country_code: string
  phone: string | null
}

export interface ShippingAddress {
  first_name: string
  last_name: string
  name: string
  company: string | null
  address1: string
  address2: string
  city: string
  province: string
  province_code: string
  zip: string
  country: string
  country_code: string
  phone: string | null
}

export interface Item {
  id: number
  product_id: number
  variant_id: number
  quantity: number
  unit_price: number
  unit_price_calculated: number
  subtotal_calculated: number
  tax: Tax
  discount: Discount
  title: string
  variant_title: string | null
  sku: string
  fulfilled: boolean
  fulfilled_quantity: number
  fulfillment_status: string
}

export interface Tax {
  name: string
  value: number
  unit_amount: number
}

export interface Discount {
  name: string
  percent: number
}

export interface GlobalDiscount {
  name: string
  percent: number
  amount: number
}

export interface Refund {
  id: number
  created_at: string
  note: string
  refund_line_items: RefundLineItem[]
  transactions: Transaction[]
}

export interface RefundLineItem {
  line_item_id: number
  quantity: number
  restock_type: string
  location_id: number
  subtotal: number
  total_tax: number
}

export interface Transaction {
  id: number
  admin_graphql_api_id: string
  amount: string
  authorization?: string
  created_at: string
  currency: string
  device_id: any
  error_code: any
  gateway: string
  kind: string
  location_id: any
  message: string
  order_id: number
  parent_id?: number
  payment_id: string
  processed_at: string
  receipt: any
  source_name: string
  status: string
  test: boolean
  user_id: number
}

export interface Credit {
  refund_id: number
  amount: number
  line_items: LineItem[]
}

export interface LineItem {
  id: number
  quantity: number
  subtotal: number
  total_tax: number
}


export type ShopifyOrderNormalizationAuth = {
  apiKey: string;
  apiSecret: string;
  shopUrl: string;
  accessToken: string;
  scopes: string;
};

export type NormalizedOrderResponse = Root;
