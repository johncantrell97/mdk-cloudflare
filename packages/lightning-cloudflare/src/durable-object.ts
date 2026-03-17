import { DurableObject as RuntimeDurableObject } from 'cloudflare:workers'
import { log } from './log.js'
import { ensureWasm } from './wasm.js'
import { refreshFees } from './storage.js'
import type { NodeStorage } from './storage.js'
import { MdkNode, deriveNodeId } from './node.js'
import { MoneyDevKitClient } from './client.js'
import { resolveDestinationToInvoice } from './lnurl.js'
import { MAINNET_MDK_NODE_OPTIONS } from './config.js'
import type {
  Checkout,
  ConfirmCheckoutOptions,
  CreateCheckoutOptions,
  Customer,
  CustomerIdentifier,
  DebugInfo,
  NodeInfo,
  PaymentResult,
  Product,
} from './types.js'

export interface LightningNodeEnv {
  MNEMONIC: string
  MDK_ACCESS_TOKEN: string
  NETWORK?: 'mainnet'
  WITHDRAWAL_DESTINATION?: string
}

type DurableObjectBaseInstance = {
  ctx: DurableObjectState
  env: LightningNodeEnv
} & Rpc.DurableObjectBranded

type DurableObjectBaseConstructor = abstract new (
  ctx: DurableObjectState,
  env: LightningNodeEnv,
) => DurableObjectBaseInstance

// Keep the runtime import for Workers, but expose only global Worker types in
// generated declarations so consumers do not need the `cloudflare:workers` module.
const DurableObjectBase = RuntimeDurableObject as unknown as DurableObjectBaseConstructor

/**
 * Lightning node Durable Object. Runs an ephemeral LDK node compiled to WASM.
 *
 * Register this class in your `wrangler.toml` and call its RPC methods from your Worker.
 * The DO handles node lifecycle, state persistence, and webhook processing.
 *
 * @example
 * ```ts
 * const node = env.LIGHTNING_NODE.get(env.LIGHTNING_NODE.idFromName('default'))
 * const checkout = await node.createCheckout({ amount: 1000, currency: 'SAT' })
 * ```
 */
export class LightningNode extends DurableObjectBase {
  private static readonly CHECKOUT_INVOICE_EXPIRY_SECS = 15 * 60

  private alarmScheduled = false

  private getNodeConfig() {
    const network = this.env.NETWORK ?? 'mainnet'
    if (network !== 'mainnet') {
      throw new Error(`Unsupported NETWORK "${network}". The public release currently supports only "mainnet".`)
    }
    return { network, preset: MAINNET_MDK_NODE_OPTIONS }
  }

  private createNode(): MdkNode {
    const { preset } = this.getNodeConfig()
    return new MdkNode({
      network: preset.network,
      mnemonic: this.env.MNEMONIC,
      mdkApiKey: this.env.MDK_ACCESS_TOKEN,
      esploraUrl: preset.esploraUrl,
      rgsUrl: preset.rgsUrl,
      lspNodeId: preset.lspNodeId,
      lspAddress: preset.lspAddress,
      lspCltvExpiryDelta: preset.lspCltvExpiryDelta,
      storage: this.ctx.storage,
    })
  }

  private async withNode<T>(fn: (node: MdkNode) => Promise<T>): Promise<T> {
    // Ensure periodic sync alarm is running (cached — avoids storage read on every request)
    if (!this.alarmScheduled) {
      const alarm = await this.ctx.storage.getAlarm()
      if (alarm === null) {
        await this.ctx.storage.setAlarm(Date.now() + 10_000)
      }
      this.alarmScheduled = true
    }

    const node = this.createNode()
    try {
      return await fn(node)
    } finally {
      node.destroy()
    }
  }

  async alarm(): Promise<void> {
    try {
      const { preset } = this.getNodeConfig()

      // 1. Refresh fee estimates → DO storage
      try {
        await refreshFees(preset.esploraUrl, this.ctx.storage as NodeStorage)
        log.debug('[alarm] Fee estimates refreshed')
      } catch (e) {
        log.warn(`[alarm] Fee fetch failed (non-fatal): ${e}`)
      }

      // 2. Chain sync + timer ticks + rebroadcast + persist
      try {
        const node = this.createNode()
        try {
          await node.periodicMaintenance()
          log.debug('[alarm] Periodic maintenance complete')
        } finally {
          node.destroy()
        }
      } catch (e) {
        log.warn(`[alarm] Periodic maintenance failed (non-fatal): ${e}`)
      }
    } finally {
      // Always reschedule — even if everything above fails
      await this.ctx.storage.setAlarm(Date.now() + 10 * 60 * 1000)
    }
  }

  private createClient(): MoneyDevKitClient {
    return new MoneyDevKitClient({ accessToken: this.env.MDK_ACCESS_TOKEN })
  }

  /** Returns the node's public key (hex). Lightweight — no WASM node restore needed. */
  async getNodeId(): Promise<string> {
    ensureWasm()
    const { preset } = this.getNodeConfig()
    return deriveNodeId(this.env.MNEMONIC, preset.network)
  }

  /** Returns the node's balance and channel information. Restores the node from storage. */
  async getNodeInfo(): Promise<NodeInfo> {
    return this.withNode(node => node.getNodeInfo())
  }

  private async registerInvoiceForCheckout(
    checkout: Checkout,
    nodeId: string,
    client: MoneyDevKitClient,
    node: MdkNode,
  ): Promise<Checkout> {
    if (checkout.status !== 'CONFIRMED') {
      return checkout
    }

    const description = 'mdk invoice'
    const expirySecs = LightningNode.CHECKOUT_INVOICE_EXPIRY_SECS
    const amountSats = checkout.invoiceAmountSats ?? null
    const amountMsat = amountSats == null ? null : amountSats * 1000

    const details = checkout.invoiceScid
      ? amountMsat == null
        ? await node.getVariableAmountJitInvoiceWithScid(checkout.invoiceScid, description, expirySecs)
        : await node.getInvoiceWithScid(checkout.invoiceScid, amountMsat, description, expirySecs)
      : amountMsat == null
        ? await node.getVariableAmountJitInvoice(description, expirySecs)
        : await node.getInvoice(amountMsat, description, expirySecs)

    return client.checkouts.registerInvoice({
      checkoutId: checkout.id,
      nodeId,
      invoice: details.bolt11,
      paymentHash: details.paymentHash,
      scid: details.scid,
      invoiceExpiresAt: new Date(details.expiresAt * 1000),
    })
  }

  /**
   * Creates a checkout via the MDK API, generates a Lightning invoice, and registers it.
   * Returns the checkout with the invoice attached.
   */
  async createCheckout(options: CreateCheckoutOptions): Promise<Checkout> {
    const nodeId = await this.getNodeId()
    const client = this.createClient()

    return this.withNode(async (node) => {
      // 1. Create checkout on MDK
      const checkout = await client.checkouts.create(options, nodeId)

      // 2. Generate/register invoice only when MDK has fully confirmed the checkout.
      return this.registerInvoiceForCheckout(checkout, nodeId, client, node)
    })
  }

  /** Confirms a checkout, then generates and registers the Lightning invoice. */
  async confirmCheckout(confirm: ConfirmCheckoutOptions): Promise<Checkout> {
    const nodeId = await this.getNodeId()
    const client = this.createClient()

    return this.withNode(async (node) => {
      const checkout = await client.checkouts.confirm(confirm)
      return this.registerInvoiceForCheckout(checkout, nodeId, client, node)
    })
  }

  /** Polls the current status of a checkout from the MDK API. */
  async getCheckout(id: string): Promise<Checkout> {
    const client = this.createClient()
    return client.checkouts.get({ id })
  }

  /** Lists products available to the configured MDK account. */
  async listProducts(): Promise<Product[]> {
    const client = this.createClient()
    const result = await client.products.list()
    return result.products
  }

  /** Fetches a customer by external ID, email, or customer ID. */
  async getCustomer(identifier: CustomerIdentifier, includeSandbox = false): Promise<Customer> {
    const client = this.createClient()
    return client.customers.get({ ...identifier, includeSandbox })
  }

  /** Sends an outbound payment for the given BOLT11 invoice. */
  async pay(bolt11: string): Promise<PaymentResult> {
    return this.withNode(node => node.pay(bolt11))
  }

  /** Returns debug information: node config, chain tip, and channel details. */
  async debug(): Promise<DebugInfo> {
    const { network, preset } = this.getNodeConfig()
    const nodeId = await this.getNodeId()

    // Chain tip and node info are independent — fetch in parallel
    const [chainTip, nodeInfo]: [DebugInfo['chain'], DebugInfo['nodeInfo']] = await Promise.all([
      this.fetchChainTip(preset.esploraUrl),
      this.getNodeInfo().catch(err => ({ error: String(err) })),
    ])
    const channels = 'error' in nodeInfo ? [] : nodeInfo.channels

    return {
      node: { nodeId, network },
      config: {
        esploraUrl: preset.esploraUrl,
        rgsUrl: preset.rgsUrl,
        lspNodeId: preset.lspNodeId,
        lspAddress: preset.lspAddress,
      },
      chain: chainTip,
      nodeInfo,
      channels,
    }
  }

  private async fetchChainTip(esploraUrl: string): Promise<DebugInfo['chain']> {
    try {
      const [hashResp, heightResp] = await Promise.all([
        fetch(`${esploraUrl}/blocks/tip/hash`),
        fetch(`${esploraUrl}/blocks/tip/height`),
      ])
      if (!hashResp.ok || !heightResp.ok) {
        throw new Error(`Chain tip fetch failed: hash=${hashResp.status} height=${heightResp.status}`)
      }
      const hash = await hashResp.text()
      const heightText = await heightResp.text()
      const height = parseInt(heightText, 10)
      if (Number.isNaN(height)) {
        throw new Error(`Invalid chain tip height: ${heightText}`)
      }
      return { hash, height }
    } catch (err) {
      return { error: String(err) }
    }
  }

  async fetch(request: Request): Promise<Response> {
    // Authenticate
    const secret = request.headers.get('x-moneydevkit-webhook-secret')
    if (!secret || !timingSafeEqual(secret, this.env.MDK_ACCESS_TOKEN)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: { handler?: string; amount?: number }
    try {
      body = await request.json() as { handler?: string; amount?: number }
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const handler = body.handler

    if (!handler) {
      return Response.json({ error: 'Missing handler' }, { status: 400 })
    }

    try {
      if (handler === 'webhooks') {
        return await this.handleWebhook()
      }

      if (handler === 'payout') {
        const amount = body.amount
        if (amount == null || amount <= 0) {
          return Response.json({ error: 'Missing or invalid amount' }, { status: 400 })
        }
        return await this.handlePayout(amount)
      }

      if (handler === 'balance') {
        const info = await this.getNodeInfo()
        return Response.json(info.balanceSats)
      }

      if (handler === 'list_channels') {
        const info = await this.getNodeInfo()
        return Response.json(info.channels)
      }

      if (handler === 'ping') {
        return Response.json({ status: 'ok' })
      }

      return Response.json({ error: `Unknown handler: ${handler}` }, { status: 400 })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error(`[${handler}] Error: ${msg}`)
      return Response.json({ error: msg }, { status: 500 })
    }
  }

  private async handleWebhook(): Promise<Response> {
    return this.withNode(async (node) => {
      log.info('[webhooks] Starting payment claim flow...')
      const received = await node.receivePayments()
      log.info(`[webhooks] Claimed ${received.length} payments`)

      if (received.length > 0) {
        log.debug(`[webhooks] Claimed: ${JSON.stringify(received)}`)
        const client = this.createClient()
        await client.checkouts.paymentReceived({
          payments: received.map((p) => ({
            paymentHash: p.paymentHash,
            amountSats: p.amount,
            sandbox: false,
          })),
        })
        log.info(`[webhooks] Confirmed ${received.length} payments to MDK`)
      }

      return Response.json({ status: 'ok', received: received.length, payments: received })
    })
  }

  private async handlePayout(amountSats: number): Promise<Response> {
    const dest = this.env.WITHDRAWAL_DESTINATION
    if (!dest) {
      return Response.json({ error: 'WITHDRAWAL_DESTINATION not configured' }, { status: 400 })
    }

    const amountMsat = amountSats * 1000
    log.info(`[payout] Resolving ${dest} for ${amountSats} sats...`)
    const bolt11 = await resolveDestinationToInvoice(dest, amountMsat)
    log.debug(`[payout] Got invoice, paying...`)

    const result = await this.pay(bolt11)
    log.info(`[payout] Payment sent: hash=${result.paymentHash}`)

    return Response.json({ status: 'ok', ...result })
  }
}

const encoder = new TextEncoder()

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  const ab = encoder.encode(a)
  const bb = encoder.encode(b)
  let mismatch = 0
  for (let i = 0; i < ab.length; i++) {
    mismatch |= ab[i] ^ bb[i]
  }
  return mismatch === 0
}
