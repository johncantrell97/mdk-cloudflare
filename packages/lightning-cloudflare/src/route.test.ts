import { describe, expect, it, vi } from 'vitest'
import {
  createCheckoutUrl,
  handleUnifiedRequest,
  parseCheckoutQueryParams,
  sanitizeCheckoutPath,
  verifyCheckoutSignature,
} from './route.js'
import type { UnifiedCheckoutNode } from './route.js'

function createNode(): UnifiedCheckoutNode {
  return {
    fetch: vi.fn(async () => Response.json({ status: 'ok' })),
    createCheckout: vi.fn(async () => ({ id: 'checkout_123', status: 'UNCONFIRMED' })),
    confirmCheckout: vi.fn(async () => ({ id: 'checkout_123', status: 'PENDING_PAYMENT' })),
    getCheckout: vi.fn(async () => ({ id: 'checkout_123', status: 'PENDING_PAYMENT' })),
    listProducts: vi.fn(async () => [{ id: 'prod_123', name: 'Test Product' }]),
    getCustomer: vi.fn(async () => ({ id: 'cust_123', email: 'test@example.com', subscriptions: [] })),
  }
}

const options = {
  accessToken: 'mdk_test_secret',
}

describe('route helpers', () => {
  it('creates signed checkout URLs that verify successfully', async () => {
    const url = await createCheckoutUrl({
      amount: 2500,
      currency: 'SAT',
      metadata: { orderId: '123' },
      checkoutPath: '/pay',
    }, options)

    const params = new URL(url, 'https://worker.example').searchParams
    expect(await verifyCheckoutSignature(params, params.get('signature')!, options.accessToken)).toBe(true)
    expect(parseCheckoutQueryParams(params)).toMatchObject({
      amount: 2500,
      currency: 'SAT',
      metadata: { orderId: '123' },
      checkoutPath: '/pay',
    })
  })

  it('sanitizes invalid checkout paths', () => {
    expect(sanitizeCheckoutPath('https://evil.example')).toBe('/checkout')
    expect(sanitizeCheckoutPath('//evil.example')).toBe('/checkout')
    expect(sanitizeCheckoutPath('/checkout?foo=bar')).toBe('/checkout')
    expect(sanitizeCheckoutPath('/pay')).toBe('/pay')
  })
})

describe('handleUnifiedRequest', () => {
  it('creates a checkout through the unified POST route when CSRF is valid', async () => {
    const node = createNode()
    const response = await handleUnifiedRequest(new Request('https://worker.example/api/mdk', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: 'mdk_csrf=csrf-token',
        'x-moneydevkit-csrf-token': 'csrf-token',
        origin: 'https://worker.example',
        host: 'worker.example',
      },
      body: JSON.stringify({
        handler: 'create_checkout',
        params: {
          amount: 2500,
          currency: 'SAT',
          checkoutPath: '/pay',
        },
      }),
    }), { ...options, node })

    expect(node.createCheckout).toHaveBeenCalledWith({
      amount: 2500,
      currency: 'SAT',
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      data: { id: 'checkout_123', status: 'UNCONFIRMED' },
    })
  })

  it('rejects browser POST requests without CSRF tokens', async () => {
    const node = createNode()
    const response = await handleUnifiedRequest(new Request('https://worker.example/api/mdk', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        handler: 'create_checkout',
        params: { amount: 2500, currency: 'SAT' },
      }),
    }), { ...options, node })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
  })

  it('confirms a checkout through the unified POST route', async () => {
    const node = createNode()
    const response = await handleUnifiedRequest(new Request('https://worker.example/api/mdk', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: 'mdk_csrf=csrf-token',
        'x-moneydevkit-csrf-token': 'csrf-token',
      },
      body: JSON.stringify({
        handler: 'confirm_checkout',
        confirm: {
          checkoutId: 'checkout_123',
          customer: { email: 'test@example.com' },
        },
      }),
    }), { ...options, node })

    expect(node.confirmCheckout).toHaveBeenCalledWith({
      checkoutId: 'checkout_123',
      customer: { email: 'test@example.com' },
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      data: { id: 'checkout_123', status: 'PENDING_PAYMENT' },
    })
  })

  it('validates customer lookup inputs', async () => {
    const node = createNode()
    const response = await handleUnifiedRequest(new Request('https://worker.example/api/mdk', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: 'mdk_csrf=csrf-token',
        'x-moneydevkit-csrf-token': 'csrf-token',
      },
      body: JSON.stringify({
        handler: 'get_customer',
        email: 'test@example.com',
        externalId: 'user_123',
      }),
    }), { ...options, node })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'Exactly one of externalId, email, or customerId must be provided',
    })
  })

  it('forwards secret-authenticated webhook calls to the durable object', async () => {
    const node = createNode()
    const response = await handleUnifiedRequest(new Request('https://worker.example/api/mdk', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-moneydevkit-webhook-secret': 'mdk_test_secret',
      },
      body: JSON.stringify({
        handler: 'webhook',
      }),
    }), { ...options, node })

    expect(node.fetch).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
  })

  it('redirects signed GET createCheckout requests to the checkout page', async () => {
    const node = createNode()
    const url = await createCheckoutUrl({
      amount: 2500,
      currency: 'SAT',
      checkoutPath: '/pay',
    }, {
      accessToken: options.accessToken,
      basePath: '/api/mdk',
    })

    const response = await handleUnifiedRequest(
      new Request(new URL(url, 'https://worker.example')),
      { ...options, node },
    )

    expect(node.createCheckout).toHaveBeenCalledWith({
      amount: 2500,
      currency: 'SAT',
    })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://worker.example/pay/checkout_123')
  })
})
