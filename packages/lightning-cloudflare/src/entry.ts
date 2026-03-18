/**
 * mdk-cloudflare — Lightning payments on Cloudflare Workers.
 *
 * Main entry: the {@link LightningNode} Durable Object class.
 *
 * @example
 * ```ts
 * import { LightningNode } from 'mdk-cloudflare'
 * export { LightningNode }
 *
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const node = env.LIGHTNING_NODE.get(env.LIGHTNING_NODE.idFromName('default'))
 *     const checkout = await node.createCheckout({ amount: 1000, currency: 'SAT' })
 *     return Response.json(checkout)
 *   }
 * }
 * ```
 *
 * @packageDocumentation
 */

// Durable Object — the main public API
export { LightningNode } from './durable-object.js'
export type { LightningNodeEnv } from './durable-object.js'

// Standalone utilities (no DO required)
export { deriveNodeId } from './index.js'
export { setLogLevel } from './log.js'
export type { LogLevel } from './log.js'

// LNURL utilities
export { resolveDestinationToInvoice, parseBolt11AmountMsat } from './lnurl.js'
export {
  createCheckoutUrl,
  createUnifiedHandler,
  handleUnifiedRequest,
  parseCheckoutQueryParams,
  sanitizeCheckoutPath,
  verifyCheckoutSignature,
} from './route.js'
export type {
  CreateCheckoutUrlOptions,
  UnifiedCheckoutNode,
  UnifiedRoute,
  UnifiedRouteOptions,
} from './route.js'

// MPP (Machine Payments Protocol) helper
export { mppCharge } from './mpp.js'
export type { MppChargeOptions, MppChargeNode, MppChallenge, MppVerification } from './mpp.js'

// Types
export { PaymentEventType } from './types.js'
export type {
  Checkout,
  CheckoutStatus,
  CheckoutCurrency,
  CheckoutCustomer,
  CheckoutType,
  ConfirmCheckoutOptions,
  ConfirmCheckoutProduct,
  CreateCheckoutOptions,
  Customer,
  CustomerIdentifier,
  CustomerInput,
  DebugInfo,
  NodeInfo,
  NodeChannel,
  PaymentResult,
  Product,
  ProductPrice,
  ReceivedPayment,
} from './types.js'
