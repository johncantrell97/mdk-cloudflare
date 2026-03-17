/** Internal node configuration. Used by MdkNode constructor. */
export interface MdkNodeOptions {
  network: string
  mdkApiKey: string
  mnemonic: string
  esploraUrl: string
  rgsUrl?: string
  lspNodeId: string
  /** LSP address in "host:port" format */
  lspAddress: string
  lspCltvExpiryDelta?: number
}

/** Invoice details returned after generating a Lightning invoice. */
export interface PaymentMetadata {
  /** BOLT11 payment request string */
  bolt11: string
  /** Hex-encoded payment hash */
  paymentHash: string
  /** Unix timestamp (seconds) when the invoice expires */
  expiresAt: number
  /** Short channel ID used for routing */
  scid: string
}

/** A claimed inbound payment. */
export interface ReceivedPayment {
  /** Hex-encoded payment hash */
  paymentHash: string
  /** Amount received in satoshis */
  amount: number
}

/** Result of an outbound payment. */
export interface PaymentResult {
  /** Internal payment identifier */
  paymentId: string
  /** Hex-encoded payment hash */
  paymentHash?: string
  /** Hex-encoded payment preimage (proof of payment) */
  preimage?: string
}

/**
 * Payment event types emitted during the pump loop.
 *
 * - `Claimable` — An inbound HTLC is ready to claim (payment pending).
 * - `Received` — An inbound payment has been fully claimed and confirmed.
 * - `Failed` — An outbound payment attempt has failed.
 * - `Sent` — An outbound payment has been successfully delivered.
 */
export enum PaymentEventType {
  Claimable = 0,
  Received = 1,
  Failed = 2,
  Sent = 3,
}

/** Payment lifecycle event from LDK. */
export interface PaymentEvent {
  eventType: PaymentEventType
  paymentHash: string
  amountMsat?: number
  reason?: string
  payerNote?: string
  paymentId?: string
  preimage?: string
}

/** Node balance and channel summary. */
export interface NodeInfo {
  /** Total spendable balance in satoshis across all channels */
  balanceSats: number
  /** Open channels */
  channels: NodeChannel[]
}

/** A Lightning channel. */
export interface NodeChannel {
  channelId: string
  counterpartyNodeId: string
  shortChannelId?: string
  /** Inbound liquidity in millisatoshis */
  inboundCapacityMsat: number
  /** Outbound liquidity in millisatoshis */
  outboundCapacityMsat: number
  isChannelReady: boolean
  isUsable: boolean
  isPublic: boolean
}

/** Debug snapshot returned by {@link LightningNode.debug}. */
export interface DebugInfo {
  /** Node identity and selected network. */
  node: {
    nodeId: string
    network: 'mainnet'
  }
  /** Effective upstream service configuration. */
  config: {
    esploraUrl: string
    rgsUrl?: string
    lspNodeId: string
    lspAddress: string
  }
  /** Current chain tip, or an error if it could not be fetched. */
  chain: { hash: string; height: number } | { error: string }
  /** Full node summary, or an error if the node could not be restored. */
  nodeInfo: NodeInfo | { error: string }
  /** Convenience alias for `nodeInfo.channels` when available. */
  channels: NodeChannel[]
}

/** Checkout lifecycle status. */
export type CheckoutStatus =
  | 'UNCONFIRMED'
  | 'CONFIRMED'
  | 'PENDING_PAYMENT'
  | 'PAYMENT_RECEIVED'
  | 'EXPIRED'
  | 'pending'
  | 'completed'
  | 'expired'
  | (string & {})

/** Supported checkout currencies. */
export type CheckoutCurrency = 'USD' | 'SAT' | (string & {})

/** Supported checkout types. */
export type CheckoutType = 'AMOUNT' | 'PRODUCTS' | 'TOP_UP' | (string & {})

/** Customer data attached to a checkout. */
export interface CheckoutCustomer {
  name?: string | null
  email?: string | null
  externalId?: string | null
  [key: string]: string | null | undefined
}

/** Customer lookup input. Exactly one field should be set. */
export type CustomerIdentifier =
  | { externalId: string; email?: never; customerId?: never }
  | { email: string; externalId?: never; customerId?: never }
  | { customerId: string; externalId?: never; email?: never }

/** Customer data collected from the buyer while confirming a checkout. */
export type CustomerInput = {
  name?: string
  email?: string
  externalId?: string
} & Record<string, string>

/** Product price details from the MDK API. */
export interface ProductPrice {
  id?: string
  amountType?: 'FIXED' | 'CUSTOM' | 'FREE' | (string & {})
  priceAmount?: number | null
  currency?: CheckoutCurrency
}

/** A MoneyDevKit checkout. */
export interface Checkout {
  /** Checkout ID */
  id: string
  /** Current lifecycle status. */
  status: CheckoutStatus
  /** Checkout type. */
  type?: CheckoutType
  /** Checkout currency. */
  currency?: CheckoutCurrency
  /** BOLT11 invoice details. */
  invoice?: {
    invoice: string
    expiresAt?: string | Date
    paymentHash?: string
    amountSats?: number | null
    amountSatsReceived?: number | null
    currency?: CheckoutCurrency
    fiatAmount?: number | null
    btcPrice?: number | null
    [key: string]: unknown
  } | null
  /** Hex-encoded payment hash. Present after invoice generation. */
  paymentHash?: string
  /** MDK-hosted payment page URL. Present when the checkout is created. */
  paymentUrl?: string
  /** Short channel ID assigned by LSP. Present after invoice generation. */
  invoiceScid?: string | null
  /** Invoice amount in satoshis. Present when the checkout has a fixed amount. */
  invoiceAmountSats?: number | null
  /** Checkout success redirect URL. */
  successUrl?: string | null
  /** Buyer-supplied metadata attached to the checkout. */
  userMetadata?: Record<string, unknown> | null
  /** Customer fields required at confirmation time. */
  requireCustomerData?: string[] | null
  /** Customer attached to this checkout. */
  customer?: CheckoutCustomer | null
  /** Products attached to this checkout. */
  products?: Product[] | null
  /** Selected product ID. */
  productId?: string | null
  /** User-entered amount for amount or custom-price checkouts. */
  providedAmount?: number | null
  /** Total amount in checkout currency. */
  totalAmount?: number | null
  /** Net amount in checkout currency. */
  netAmount?: number | null
  /** Tax amount in checkout currency. */
  taxAmount?: number | null
  /** Discount amount in checkout currency. */
  discountAmount?: number | null
  /** Convenience field for future-compatible passthrough data. */
  [key: string]: unknown
}

type CreateCheckoutCommon = {
  /** URL to redirect to after successful payment */
  successUrl?: string
  /** Arbitrary metadata attached to the checkout */
  metadata?: Record<string, unknown>
  /** Optional customer data to prefill at checkout */
  customer?: CustomerInput
  /** Customer fields required before invoice generation */
  requireCustomerData?: string[]
  /** Whether the checkout can accept discount codes */
  allowDiscountCodes?: boolean
}

/** Options for creating a new checkout. */
export type CreateCheckoutOptions =
  | (CreateCheckoutCommon & {
    type?: 'AMOUNT'
    /** Amount in the specified currency */
    amount: number
    /** Currency for the amount. Defaults to 'SAT'. */
    currency?: Extract<CheckoutCurrency, 'USD' | 'SAT'> | undefined
    /** Optional title stored in metadata by the upstream API */
    title?: string
    /** Optional description stored in metadata by the upstream API */
    description?: string
    product?: never
  })
  | (CreateCheckoutCommon & {
    type: 'PRODUCTS'
    /** Product ID to include in this checkout */
    product: string
    amount?: never
    currency?: never
    title?: never
    description?: never
  })
  | (CreateCheckoutCommon & {
    type: 'TOP_UP'
    amount?: never
    currency?: Extract<CheckoutCurrency, 'USD' | 'SAT'> | undefined
    title?: string
    description?: string
    product?: never
  })

/** Product selection when confirming a checkout. */
export interface ConfirmCheckoutProduct {
  productId: string
  priceAmount?: number
}

/** Options for confirming a checkout before invoice generation. */
export interface ConfirmCheckoutOptions {
  checkoutId: string
  customer?: CustomerInput
  products?: ConfirmCheckoutProduct[]
}

/** Internal: register an invoice with the MDK API. */
export interface RegisterInvoice {
  checkoutId: string
  nodeId: string
  invoice: string
  paymentHash: string
  scid: string
  invoiceExpiresAt: Date
}

/** Internal: confirm received payments to the MDK API. */
export interface PaymentReceived {
  payments: Array<{
    paymentHash: string
    amountSats: number
    sandbox?: boolean
  }>
}

/** Customer response from the MDK API. */
export interface Customer {
  id?: string
  email?: string | null
  name?: string | null
  externalId?: string | null
  subscriptions?: Array<{
    id?: string
    status?: string
    [key: string]: unknown
  }>
  [key: string]: unknown
}

/** An MDK product. */
export interface Product {
  id: string
  name: string
  description?: string
  prices?: ProductPrice[] | null
  recurringInterval?: string | null
  [key: string]: unknown
}
