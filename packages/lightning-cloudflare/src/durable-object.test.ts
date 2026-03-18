import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  ensureWasm,
  refreshFees,
  deriveNodeId,
  resolveDestinationToInvoice,
  log,
  clientGetCheckout,
  clientCreateCheckout,
  clientConfirmCheckout,
  clientRegisterInvoice,
  clientPaymentReceived,
  clientListProducts,
  clientGetCustomer,
  nodeGetNodeInfo,
  nodeGetInvoice,
  nodeGetInvoiceWithScid,
  nodeGetVariableAmountJitInvoice,
  nodeGetVariableAmountJitInvoiceWithScid,
  nodeReceivePayments,
  nodePay,
  nodePeriodicMaintenance,
  nodeDestroy,
} = vi.hoisted(() => ({
  ensureWasm: vi.fn(),
  refreshFees: vi.fn(),
  deriveNodeId: vi.fn(() => '02'.padEnd(66, '1')),
  resolveDestinationToInvoice: vi.fn(),
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  clientGetCheckout: vi.fn(),
  clientCreateCheckout: vi.fn(),
  clientConfirmCheckout: vi.fn(),
  clientRegisterInvoice: vi.fn(),
  clientPaymentReceived: vi.fn(),
  clientListProducts: vi.fn(),
  clientGetCustomer: vi.fn(),
  nodeGetNodeInfo: vi.fn(),
  nodeGetInvoice: vi.fn(),
  nodeGetInvoiceWithScid: vi.fn(),
  nodeGetVariableAmountJitInvoice: vi.fn(),
  nodeGetVariableAmountJitInvoiceWithScid: vi.fn(),
  nodeReceivePayments: vi.fn(),
  nodePay: vi.fn(),
  nodePeriodicMaintenance: vi.fn(),
  nodeDestroy: vi.fn(),
}))

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown
    env: unknown

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx
      this.env = env
    }
  },
}))

vi.mock('./wasm.js', () => ({ ensureWasm }))
vi.mock('./storage.js', () => ({ refreshFees }))
vi.mock('./log.js', () => ({ log }))
vi.mock('./lnurl.js', () => ({ resolveDestinationToInvoice }))
vi.mock('./config.js', () => ({
  MAINNET_MDK_NODE_OPTIONS: {
    network: 'mainnet',
    esploraUrl: 'https://esplora.example.com',
    rgsUrl: 'https://rgs.example.com',
    lspNodeId: '02'.padEnd(66, '2'),
    lspAddress: 'lsp.example.com:9735',
    lspCltvExpiryDelta: 72,
  },
}))
vi.mock('./client.js', () => ({
  MoneyDevKitClient: class {
    checkouts = {
      get: clientGetCheckout,
      create: clientCreateCheckout,
      confirm: clientConfirmCheckout,
      registerInvoice: clientRegisterInvoice,
      paymentReceived: clientPaymentReceived,
    }
    products = {
      list: clientListProducts,
    }
    customers = {
      get: clientGetCustomer,
    }
  },
}))
vi.mock('./node.js', () => ({
  deriveNodeId,
  MdkNode: class {
    destroy() { nodeDestroy() }
    getNodeInfo(...args: unknown[]) { return nodeGetNodeInfo(...args) }
    getInvoice(...args: unknown[]) { return nodeGetInvoice(...args) }
    getInvoiceWithScid(...args: unknown[]) { return nodeGetInvoiceWithScid(...args) }
    getVariableAmountJitInvoice(...args: unknown[]) { return nodeGetVariableAmountJitInvoice(...args) }
    getVariableAmountJitInvoiceWithScid(...args: unknown[]) { return nodeGetVariableAmountJitInvoiceWithScid(...args) }
    receivePayments(...args: unknown[]) { return nodeReceivePayments(...args) }
    pay(bolt11: string) { return nodePay(bolt11) }
    periodicMaintenance(...args: unknown[]) { return nodePeriodicMaintenance(...args) }
  },
}))

import { LightningNode } from './durable-object.js'

interface MockStorage {
  getAlarm: ReturnType<typeof vi.fn>
  setAlarm: ReturnType<typeof vi.fn>
  put: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
  list: ReturnType<typeof vi.fn>
  sync: ReturnType<typeof vi.fn>
}

function createMockStorage(): MockStorage {
  return {
    getAlarm: vi.fn().mockResolvedValue(null),
    setAlarm: vi.fn().mockResolvedValue(undefined),
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(0),
    list: vi.fn().mockResolvedValue(new Map()),
    sync: vi.fn().mockResolvedValue(undefined),
  }
}

function createObject(envOverrides: Record<string, unknown> = {}) {
  const storage = createMockStorage()
  const ctx = { storage }
  const env = {
    MNEMONIC: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    MDK_ACCESS_TOKEN: 'mdk_api_secret',
    ...envOverrides,
  }

  return {
    storage,
    node: new LightningNode(ctx as never, env as never),
  }
}

describe('LightningNode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(globalThis, 'fetch').mockReset()
  })

  it('authenticates webhook-style requests with the MDK access token', async () => {
    const { node } = createObject()

    const response = await node.fetch(new Request('https://worker.example/api/mdk', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-moneydevkit-webhook-secret': 'mdk_api_secret',
      },
      body: JSON.stringify({ handler: 'ping' }),
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
  })

  it('rejects unsupported NETWORK values', async () => {
    const { node } = createObject({ NETWORK: 'signet' })

    await expect(node.getNodeId()).rejects.toThrow(
      'Unsupported NETWORK "signet". The public release currently supports only "mainnet".'
    )
  })

  it('returns 400 for invalid JSON webhook bodies', async () => {
    const { node } = createObject()

    const response = await node.fetch(new Request('https://worker.example/api/mdk', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-moneydevkit-webhook-secret': 'mdk_api_secret',
      },
      body: '{not-json',
    }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid JSON body' })
  })

  it('claims webhook payments and confirms them back to MDK', async () => {
    nodeReceivePayments.mockResolvedValueOnce([
      { paymentHash: 'hash_123', amount: 42 },
    ])

    const { node, storage } = createObject()
    const response = await node.fetch(new Request('https://worker.example/api/mdk', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-moneydevkit-webhook-secret': 'mdk_api_secret',
      },
      body: JSON.stringify({ handler: 'webhooks' }),
    }))

    expect(storage.setAlarm).toHaveBeenCalledTimes(1)
    expect(clientPaymentReceived).toHaveBeenCalledWith({
      payments: [{ paymentHash: 'hash_123', amountSats: 42, sandbox: false }],
    })
    expect(nodeDestroy).toHaveBeenCalled()
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      received: 1,
      payments: [{ paymentHash: 'hash_123', amount: 42 }],
    })
  })

  it('creates a checkout, generates an invoice, and registers it with MDK', async () => {
    clientCreateCheckout.mockResolvedValueOnce({
      id: 'checkout_123',
      status: 'CONFIRMED',
      paymentUrl: 'https://pay.example.com/checkout_123',
      invoiceAmountSats: 2500,
      invoiceScid: '123x1x0',
    })
    nodeGetInvoiceWithScid.mockResolvedValueOnce({
      bolt11: 'lnbc2500n1...',
      paymentHash: 'hash_123',
      scid: '123x1x0',
      expiresAt: 1_700_000_000,
    })
    clientRegisterInvoice.mockResolvedValueOnce({
      id: 'checkout_123',
      status: 'PENDING_PAYMENT',
      paymentUrl: 'https://pay.example.com/checkout_123',
      invoiceAmountSats: 2500,
      invoiceScid: '123x1x0',
      invoice: {
        invoice: 'lnbc2500n1...',
        paymentHash: 'hash_123',
        amountSats: 2500,
      },
    })

    const { node } = createObject()
    const checkout = await node.createCheckout({ amount: 2500, currency: 'SAT' })

    expect(ensureWasm).toHaveBeenCalled()
    expect(deriveNodeId).toHaveBeenCalled()
    expect(clientCreateCheckout).toHaveBeenCalledWith({ amount: 2500, currency: 'SAT' }, '02'.padEnd(66, '1'))
    expect(nodeGetInvoiceWithScid).toHaveBeenCalledWith('123x1x0', 2_500_000, 'mdk invoice', 900)
    expect(clientRegisterInvoice).toHaveBeenCalledWith({
      checkoutId: 'checkout_123',
      nodeId: '02'.padEnd(66, '1'),
      invoice: 'lnbc2500n1...',
      paymentHash: 'hash_123',
      scid: '123x1x0',
      invoiceExpiresAt: new Date(1_700_000_000 * 1000),
    })
    expect(checkout).toEqual({
      id: 'checkout_123',
      status: 'PENDING_PAYMENT',
      paymentUrl: 'https://pay.example.com/checkout_123',
      invoiceAmountSats: 2500,
      invoiceScid: '123x1x0',
      invoice: {
        invoice: 'lnbc2500n1...',
        paymentHash: 'hash_123',
        amountSats: 2500,
      },
    })
  })

  it('returns unconfirmed checkouts without generating an invoice', async () => {
    clientCreateCheckout.mockResolvedValueOnce({
      id: 'checkout_123',
      status: 'UNCONFIRMED',
      type: 'PRODUCTS',
      products: [{ id: 'prod_123', name: 'Test Product' }],
      requireCustomerData: ['email'],
    })

    const { node } = createObject()
    const checkout = await node.createCheckout({ type: 'PRODUCTS', product: 'prod_123' })

    expect(nodeGetInvoice).not.toHaveBeenCalled()
    expect(nodeGetInvoiceWithScid).not.toHaveBeenCalled()
    expect(clientRegisterInvoice).not.toHaveBeenCalled()
    expect(checkout).toEqual({
      id: 'checkout_123',
      status: 'UNCONFIRMED',
      type: 'PRODUCTS',
      products: [{ id: 'prod_123', name: 'Test Product' }],
      requireCustomerData: ['email'],
    })
  })

  it('confirms a checkout and uses a variable-amount invoice when MDK does not return invoiceAmountSats', async () => {
    clientConfirmCheckout.mockResolvedValueOnce({
      id: 'checkout_123',
      status: 'CONFIRMED',
      type: 'TOP_UP',
      invoiceScid: '123x1x0',
      invoiceAmountSats: null,
    })
    nodeGetVariableAmountJitInvoiceWithScid.mockResolvedValueOnce({
      bolt11: 'lnbc1variable...',
      paymentHash: 'hash_var',
      scid: '123x1x0',
      expiresAt: 1_700_000_100,
    })
    clientRegisterInvoice.mockResolvedValueOnce({
      id: 'checkout_123',
      status: 'PENDING_PAYMENT',
      type: 'TOP_UP',
      invoiceScid: '123x1x0',
      invoiceAmountSats: null,
      invoice: {
        invoice: 'lnbc1variable...',
        paymentHash: 'hash_var',
        amountSats: null,
      },
    })

    const { node } = createObject()
    const checkout = await node.confirmCheckout({
      checkoutId: 'checkout_123',
      customer: { email: 'test@example.com' },
    })

    expect(clientConfirmCheckout).toHaveBeenCalledWith({
      checkoutId: 'checkout_123',
      customer: { email: 'test@example.com' },
    })
    expect(nodeGetVariableAmountJitInvoiceWithScid).toHaveBeenCalledWith('123x1x0', 'mdk invoice', 900)
    expect(checkout).toEqual({
      id: 'checkout_123',
      status: 'PENDING_PAYMENT',
      type: 'TOP_UP',
      invoiceScid: '123x1x0',
      invoiceAmountSats: null,
      invoice: {
        invoice: 'lnbc1variable...',
        paymentHash: 'hash_var',
        amountSats: null,
      },
    })
  })

  it('lists products from the MDK API', async () => {
    clientListProducts.mockResolvedValueOnce({
      products: [{ id: 'prod_123', name: 'Test Product' }],
    })

    const { node } = createObject()
    await expect(node.listProducts()).resolves.toEqual([{ id: 'prod_123', name: 'Test Product' }])
  })

  it('fetches customers from the MDK API', async () => {
    clientGetCustomer.mockResolvedValueOnce({
      id: 'cust_123',
      email: 'test@example.com',
      subscriptions: [],
    })

    const { node } = createObject()
    await expect(node.getCustomer({ email: 'test@example.com' }, true)).resolves.toEqual({
      id: 'cust_123',
      email: 'test@example.com',
      subscriptions: [],
    })
    expect(clientGetCustomer).toHaveBeenCalledWith({
      email: 'test@example.com',
      includeSandbox: true,
    })
  })

  it('reports chain tip fetch failures in debug output', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('bad', { status: 500 }))
      .mockResolvedValueOnce(new Response('0', { status: 200 }))
    nodeGetNodeInfo.mockResolvedValueOnce({ balanceSats: 0, channels: [] })

    const { node } = createObject()
    const debug = await node.debug()

    expect(debug).toEqual({
      node: { nodeId: '02'.padEnd(66, '1'), network: 'mainnet' },
      config: {
        esploraUrl: 'https://esplora.example.com',
        rgsUrl: 'https://rgs.example.com',
        lspNodeId: '02'.padEnd(66, '2'),
        lspAddress: 'lsp.example.com:9735',
      },
      chain: { error: 'Error: Chain tip fetch failed: hash=500 height=200' },
      nodeInfo: { balanceSats: 0, channels: [] },
      channels: [],
    })
  })

  describe('createMppChallenge', () => {
    it('creates a checkout, stores challenge, and returns challenge data', async () => {
      const { node, storage } = createObject()

      const checkout = {
        id: 'checkout_mpp_1',
        status: 'PENDING_PAYMENT',
        invoice: {
          invoice: 'lnbc100test...',
          paymentHash: 'aa'.repeat(32),
        },
        paymentHash: 'aa'.repeat(32),
      }
      clientCreateCheckout.mockResolvedValueOnce({ id: 'checkout_mpp_1', status: 'CONFIRMED', invoiceAmountSats: 100 })
      clientRegisterInvoice.mockResolvedValueOnce(checkout)
      nodeGetInvoice.mockResolvedValueOnce({
        bolt11: 'lnbc100test...',
        paymentHash: 'aa'.repeat(32),
        expiresAt: Math.floor(Date.now() / 1000) + 900,
        scid: '123x456x0',
      })

      const result = await node.createMppChallenge(100)

      expect(result.challengeId).toBeDefined()
      expect(result.invoice).toBe('lnbc100test...')
      expect(result.paymentHash).toBe('aa'.repeat(32))
      expect(result.amountSats).toBe(100)
      expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000))

      // Verify challenge stored
      expect(storage.put).toHaveBeenCalledWith(
        expect.objectContaining({
          [`mpp/${result.challengeId}`]: expect.objectContaining({
            paymentHash: 'aa'.repeat(32),
            checkoutId: 'checkout_mpp_1',
          }),
        }),
      )
    })

    it('throws when checkout has no invoice', async () => {
      const { node } = createObject()

      clientCreateCheckout.mockResolvedValueOnce({ id: 'checkout_2', status: 'UNCONFIRMED' })

      await expect(node.createMppChallenge(100)).rejects.toThrow()
    })
  })

  describe('verifyMppCredential', () => {
    // Helper: SHA256 a hex preimage to get paymentHash
    async function sha256hex(hexPreimage: string): Promise<string> {
      const bytes = new Uint8Array(hexPreimage.match(/.{2}/g)!.map((b) => parseInt(b, 16)))
      const hash = await crypto.subtle.digest('SHA-256', bytes)
      return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('')
    }

    it('returns valid:true and deletes challenge when preimage matches', async () => {
      const preimage = 'ab'.repeat(32)
      const paymentHash = await sha256hex(preimage)

      const { node, storage } = createObject()
      storage.get.mockResolvedValueOnce({
        paymentHash,
        checkoutId: 'checkout_1',
        expiresAt: Math.floor(Date.now() / 1000) + 900,
      })

      const result = await node.verifyMppCredential('challenge-1', preimage)

      expect(result).toEqual({ valid: true, paymentHash })
      expect(storage.delete).toHaveBeenCalledWith('mpp/challenge-1')
    })

    it('returns valid:false when challenge not found', async () => {
      const { node, storage } = createObject()
      storage.get.mockResolvedValueOnce(undefined)

      const result = await node.verifyMppCredential('nonexistent', 'aa'.repeat(32))

      expect(result).toEqual({ valid: false })
    })

    it('returns valid:false and deletes when challenge expired', async () => {
      const { node, storage } = createObject()
      storage.get.mockResolvedValueOnce({
        paymentHash: 'aa'.repeat(32),
        checkoutId: 'checkout_1',
        expiresAt: Math.floor(Date.now() / 1000) - 10, // expired
      })

      const result = await node.verifyMppCredential('expired-challenge', 'aa'.repeat(32))

      expect(result).toEqual({ valid: false })
      expect(storage.delete).toHaveBeenCalledWith('mpp/expired-challenge')
    })

    it('returns valid:false when preimage does not match', async () => {
      const { node, storage } = createObject()
      storage.get.mockResolvedValueOnce({
        paymentHash: 'ff'.repeat(32), // won't match any preimage we provide
        checkoutId: 'checkout_1',
        expiresAt: Math.floor(Date.now() / 1000) + 900,
      })

      const result = await node.verifyMppCredential('challenge-1', 'ab'.repeat(32))

      expect(result).toEqual({ valid: false })
      // Challenge NOT deleted on mismatch (only on match or expiry)
    })

    it('prevents replay: second verification of same challenge fails', async () => {
      const preimage = 'ab'.repeat(32)
      const paymentHash = await sha256hex(preimage)

      const { node, storage } = createObject()
      // First call: challenge exists
      storage.get.mockResolvedValueOnce({
        paymentHash,
        checkoutId: 'checkout_1',
        expiresAt: Math.floor(Date.now() / 1000) + 900,
      })

      const first = await node.verifyMppCredential('challenge-replay', preimage)
      expect(first).toEqual({ valid: true, paymentHash })

      // Second call: challenge was deleted, storage returns undefined
      storage.get.mockResolvedValueOnce(undefined)

      const second = await node.verifyMppCredential('challenge-replay', preimage)
      expect(second).toEqual({ valid: false })
    })

    it('returns valid:false for malformed preimage (wrong length)', async () => {
      const { node, storage } = createObject()
      storage.get.mockResolvedValueOnce({
        paymentHash: 'aa'.repeat(32),
        checkoutId: 'checkout_1',
        expiresAt: Math.floor(Date.now() / 1000) + 900,
      })

      const result = await node.verifyMppCredential('challenge-1', 'abc') // odd length, not 32 bytes
      expect(result).toEqual({ valid: false })
    })

    it('returns valid:false for empty preimage', async () => {
      const { node, storage } = createObject()
      storage.get.mockResolvedValueOnce({
        paymentHash: 'aa'.repeat(32),
        checkoutId: 'checkout_1',
        expiresAt: Math.floor(Date.now() / 1000) + 900,
      })

      const result = await node.verifyMppCredential('challenge-1', '')
      expect(result).toEqual({ valid: false })
    })
  })

  describe('alarm - MPP cleanup', () => {
    it('deletes expired MPP challenges during alarm', async () => {
      const { node, storage } = createObject()
      const now = Math.floor(Date.now() / 1000)

      const mppEntries = new Map([
        ['mpp/expired-1', { paymentHash: 'aa'.repeat(32), checkoutId: 'c1', expiresAt: now - 100 }],
        ['mpp/valid-1', { paymentHash: 'bb'.repeat(32), checkoutId: 'c2', expiresAt: now + 900 }],
        ['mpp/expired-2', { paymentHash: 'cc'.repeat(32), checkoutId: 'c3', expiresAt: now - 50 }],
      ])
      storage.list.mockResolvedValue(mppEntries)
      nodePeriodicMaintenance.mockResolvedValue(undefined)

      await node.alarm()

      // Should batch-delete only expired keys
      expect(storage.delete).toHaveBeenCalledWith(['mpp/expired-1', 'mpp/expired-2'])
    })

    it('skips delete when no expired challenges exist', async () => {
      const { node, storage } = createObject()
      const now = Math.floor(Date.now() / 1000)

      const mppEntries = new Map([
        ['mpp/valid-1', { paymentHash: 'aa'.repeat(32), checkoutId: 'c1', expiresAt: now + 900 }],
      ])
      storage.list.mockResolvedValue(mppEntries)
      nodePeriodicMaintenance.mockResolvedValue(undefined)

      await node.alarm()

      // delete should not be called with mpp keys
      expect(storage.delete).not.toHaveBeenCalledWith(expect.arrayContaining([expect.stringContaining('mpp/')]))
    })
  })
})
