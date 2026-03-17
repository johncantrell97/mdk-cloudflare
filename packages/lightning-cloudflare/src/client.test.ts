import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MoneyDevKitClient } from './client.js'

describe('MoneyDevKitClient', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')

  beforeEach(() => {
    fetchSpy.mockReset()
  })

  it('returns parsed JSON for a successful RPC call', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      json: { id: 'checkout_123', status: 'pending' },
    })))

    const client = new MoneyDevKitClient({ accessToken: 'mdk_test', baseUrl: 'https://mdk.example/rpc' })
    const result = await client.checkouts.get({ id: 'checkout_123' })

    expect(result).toEqual({ id: 'checkout_123', status: 'pending' })
    expect(fetchSpy).toHaveBeenCalledWith('https://mdk.example/rpc/checkout/get', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'mdk_test',
      },
      body: JSON.stringify({ json: { id: 'checkout_123' } }),
    })
  })

  it('serializes invoice registration metadata in the expected wire format', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      json: { id: 'checkout_123', status: 'pending' },
    })))

    const client = new MoneyDevKitClient({ accessToken: 'mdk_test', baseUrl: 'https://mdk.example/rpc' })
    await client.checkouts.registerInvoice({
      checkoutId: 'checkout_123',
      nodeId: 'node_123',
      invoice: 'lnbc1...',
      paymentHash: 'hash_123',
      scid: '123x1x0',
      invoiceExpiresAt: new Date('2026-03-15T00:00:00.000Z'),
    })

    expect(fetchSpy).toHaveBeenCalledWith('https://mdk.example/rpc/checkout/registerInvoice', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'mdk_test',
      },
      body: JSON.stringify({
        json: {
          checkoutId: 'checkout_123',
          nodeId: 'node_123',
          invoice: 'lnbc1...',
          paymentHash: 'hash_123',
          scid: '123x1x0',
          invoiceExpiresAt: '2026-03-15T00:00:00.000Z',
        },
        meta: [[1, 'invoiceExpiresAt']],
      }),
    })
  })

  it('maps a singular product field to the upstream products array on create', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      json: { id: 'checkout_123', status: 'UNCONFIRMED', type: 'PRODUCTS' },
    })))

    const client = new MoneyDevKitClient({ accessToken: 'mdk_test', baseUrl: 'https://mdk.example/rpc' })
    await client.checkouts.create({
      type: 'PRODUCTS',
      product: 'prod_123',
      successUrl: '/success',
    }, 'node_123')

    expect(fetchSpy).toHaveBeenCalledWith('https://mdk.example/rpc/checkout/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'mdk_test',
      },
      body: JSON.stringify({
        json: {
          nodeId: 'node_123',
          type: 'PRODUCTS',
          successUrl: '/success',
          products: ['prod_123'],
        },
      }),
    })
  })

  it('posts confirm payloads to checkout/confirm', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      json: { id: 'checkout_123', status: 'CONFIRMED' },
    })))

    const client = new MoneyDevKitClient({ accessToken: 'mdk_test', baseUrl: 'https://mdk.example/rpc' })
    await client.checkouts.confirm({
      checkoutId: 'checkout_123',
      customer: { email: 'test@example.com' },
      products: [{ productId: 'prod_123', priceAmount: 2500 }],
    })

    expect(fetchSpy).toHaveBeenCalledWith('https://mdk.example/rpc/checkout/confirm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'mdk_test',
      },
      body: JSON.stringify({
        json: {
          checkoutId: 'checkout_123',
          customer: { email: 'test@example.com' },
          products: [{ productId: 'prod_123', priceAmount: 2500 }],
        },
      }),
    })
  })

  it('fetches customers through the customer/getSdk RPC', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      json: { id: 'cust_123', email: 'test@example.com', subscriptions: [] },
    })))

    const client = new MoneyDevKitClient({ accessToken: 'mdk_test', baseUrl: 'https://mdk.example/rpc' })
    const result = await client.customers.get({ email: 'test@example.com', includeSandbox: true })

    expect(result).toEqual({ id: 'cust_123', email: 'test@example.com', subscriptions: [] })
    expect(fetchSpy).toHaveBeenCalledWith('https://mdk.example/rpc/customer/getSdk', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'mdk_test',
      },
      body: JSON.stringify({
        json: {
          email: 'test@example.com',
          includeSandbox: true,
        },
      }),
    })
  })

  it('surfaces JSON error responses from the MDK API', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      json: { code: 'unauthorized', message: 'bad api key' },
    }), { status: 401 }))

    const client = new MoneyDevKitClient({ accessToken: 'bad_key' })
    await expect(client.checkouts.get({ id: 'checkout_123' })).rejects.toThrow('bad api key')
  })

  it('surfaces non-JSON error bodies when the MDK API fails', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('upstream failure', { status: 502 }))

    const client = new MoneyDevKitClient({ accessToken: 'mdk_test' })
    await expect(client.products.list()).rejects.toThrow('upstream failure')
  })

  it('throws a clear error when a success response is not valid JSON', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('not json', { status: 200 }))

    const client = new MoneyDevKitClient({ accessToken: 'mdk_test' })
    await expect(client.products.list()).rejects.toThrow(
      'MDK API returned invalid JSON for products/list'
    )
  })

  it('throws a clear error when a success response is missing the json envelope', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))

    const client = new MoneyDevKitClient({ accessToken: 'mdk_test' })
    await expect(client.products.list()).rejects.toThrow(
      'MDK API returned invalid response for products/list'
    )
  })
})
