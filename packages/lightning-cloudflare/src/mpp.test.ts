import { describe, expect, it, vi } from 'vitest'
import {
  base64urlEncode,
  base64urlDecode,
  parsePaymentAuthorization,
  formatWwwAuthenticate,
  mppCharge,
} from './mpp.js'
import type { MppChargeNode, MppChallenge } from './mpp.js'

describe('base64url', () => {
  it('round-trips JSON', () => {
    const obj = { amount: '100', currency: 'SAT', invoice: 'lnbc100...' }
    const encoded = base64urlEncode(JSON.stringify(obj))
    expect(encoded).not.toContain('+')
    expect(encoded).not.toContain('/')
    expect(encoded).not.toContain('=')
    expect(JSON.parse(base64urlDecode(encoded))).toEqual(obj)
  })

  it('handles empty string', () => {
    expect(base64urlDecode(base64urlEncode(''))).toBe('')
  })
})

describe('parsePaymentAuthorization', () => {
  it('parses valid Payment credential', () => {
    const payload = base64urlEncode(JSON.stringify({ preimage: 'aa'.repeat(32) }))
    const header = `Payment id="challenge-123",payload="${payload}"`
    const result = parsePaymentAuthorization(header)
    expect(result).toEqual({ id: 'challenge-123', preimage: 'aa'.repeat(32) })
  })

  it('returns null for non-Payment scheme', () => {
    expect(parsePaymentAuthorization('Bearer token123')).toBeNull()
  })

  it('returns null for missing id', () => {
    const payload = base64urlEncode(JSON.stringify({ preimage: 'aa'.repeat(32) }))
    expect(parsePaymentAuthorization(`Payment payload="${payload}"`)).toBeNull()
  })

  it('returns null for missing payload', () => {
    expect(parsePaymentAuthorization('Payment id="abc"')).toBeNull()
  })

  it('returns null for payload without preimage', () => {
    const payload = base64urlEncode(JSON.stringify({ other: 'value' }))
    expect(parsePaymentAuthorization(`Payment id="abc",payload="${payload}"`)).toBeNull()
  })

  it('returns null for null header', () => {
    expect(parsePaymentAuthorization(null)).toBeNull()
  })

  it('parses mppx blob format: Payment <base64url({challenge, payload})>', () => {
    const blob = {
      challenge: { id: 'mppx-challenge-id', realm: 'example.com', method: 'lightning', intent: 'charge', request: {} },
      payload: { preimage: 'ee'.repeat(32) },
    }
    const encoded = base64urlEncode(JSON.stringify(blob))
    const result = parsePaymentAuthorization(`Payment ${encoded}`)
    expect(result).toEqual({ id: 'mppx-challenge-id', preimage: 'ee'.repeat(32) })
  })

  it('returns null for mppx blob without preimage', () => {
    const blob = {
      challenge: { id: 'test', realm: 'x', method: 'lightning', intent: 'charge', request: {} },
      payload: { other: 'data' },
    }
    const encoded = base64urlEncode(JSON.stringify(blob))
    expect(parsePaymentAuthorization(`Payment ${encoded}`)).toBeNull()
  })
})

describe('formatWwwAuthenticate', () => {
  it('formats challenge header per MPP spec with amount, currency, and invoice', () => {
    const header = formatWwwAuthenticate({
      challengeId: 'uuid-123',
      invoice: 'lnbc100...',
      paymentHash: 'abc123',
      amountSats: 100,
      expiresAt: 1700000000,
    })
    expect(header).toContain('Payment ')
    expect(header).toContain('realm="mdk-cloudflare"')
    expect(header).toContain('id="uuid-123"')
    expect(header).toContain('method="lightning"')
    expect(header).toContain('intent="charge"')
    expect(header).toContain('request="')
    expect(header).toContain('expires="')

    // Decode the request parameter
    const requestMatch = header.match(/request="([^"]+)"/)
    expect(requestMatch).not.toBeNull()
    const requestJson = JSON.parse(base64urlDecode(requestMatch![1]))
    expect(requestJson).toEqual({
      amount: '100',
      currency: 'sat',
      methodDetails: {
        invoice: 'lnbc100...',
        paymentHash: 'abc123',
        network: 'mainnet',
      },
    })
  })
})

function createMockNode(overrides: Partial<MppChargeNode> = {}): MppChargeNode {
  return {
    createMppChallenge: vi.fn(async (): Promise<MppChallenge> => ({
      challengeId: 'test-challenge-id',
      invoice: 'lnbc100test...',
      paymentHash: 'a'.repeat(64),
      amountSats: 100,
      expiresAt: Math.floor(Date.now() / 1000) + 900,
    })),
    verifyMppCredential: vi.fn(async () => ({
      valid: true,
      paymentHash: 'a'.repeat(64),
    })),
    ...overrides,
  }
}

describe('mppCharge', () => {
  it('returns 402 with WWW-Authenticate when no Authorization header', async () => {
    const node = createMockNode()
    const request = new Request('https://example.com/api')
    const handler = vi.fn(async () => Response.json({ data: 'secret' }))

    const response = await mppCharge(request, node, { amount: 100 }, handler)

    expect(response.status).toBe(402)
    expect(response.headers.get('WWW-Authenticate')).toContain('Payment ')
    expect(response.headers.get('WWW-Authenticate')).toContain('method="lightning"')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(handler).not.toHaveBeenCalled()
    expect(node.createMppChallenge).toHaveBeenCalledWith(100)

    const body = await response.json() as Record<string, unknown>
    expect(body.error).toBe('Payment Required')
    expect(body.method).toBe('lightning')
    expect(body.invoice).toBe('lnbc100test...')
  })

  it('calls handler and returns 200 with Payment-Receipt on valid credential', async () => {
    const node = createMockNode()
    const payload = base64urlEncode(JSON.stringify({ preimage: 'bb'.repeat(32) }))
    const request = new Request('https://example.com/api', {
      headers: { Authorization: `Payment id="test-challenge-id",payload="${payload}"` },
    })
    const handler = vi.fn(async () => Response.json({ data: 'secret' }))

    const response = await mppCharge(request, node, { amount: 100 }, handler)

    expect(response.status).toBe(200)
    expect(handler).toHaveBeenCalled()
    expect(node.verifyMppCredential).toHaveBeenCalledWith('test-challenge-id', 'bb'.repeat(32))

    const receipt = response.headers.get('Payment-Receipt')
    expect(receipt).not.toBeNull()
    const receiptJson = JSON.parse(base64urlDecode(receipt!))
    expect(receiptJson.method).toBe('lightning')
    expect(receiptJson.reference).toBe('a'.repeat(64))
    expect(receiptJson.status).toBe('success')
    expect(receiptJson.timestamp).toBeDefined()
  })

  it('returns 402 when credential verification fails', async () => {
    const node = createMockNode({
      verifyMppCredential: vi.fn(async () => ({ valid: false })),
    })
    const payload = base64urlEncode(JSON.stringify({ preimage: 'cc'.repeat(32) }))
    const request = new Request('https://example.com/api', {
      headers: { Authorization: `Payment id="bad-id",payload="${payload}"` },
    })
    const handler = vi.fn()

    const response = await mppCharge(request, node, { amount: 100 }, handler)

    expect(response.status).toBe(402)
    expect(handler).not.toHaveBeenCalled()
    // Should include a fresh challenge so mppx clients can retry
    expect(response.headers.get('WWW-Authenticate')).toContain('Payment ')
    expect(response.headers.get('WWW-Authenticate')).toContain('method="lightning"')
    expect(node.createMppChallenge).toHaveBeenCalledWith(100)
    const body = await response.json() as Record<string, unknown>
    expect(body.error).toBe('Payment Required')
    expect(body.invoice).toBeDefined()
  })

  it('supports dynamic pricing via amount function', async () => {
    const node = createMockNode()
    const request = new Request('https://example.com/api', {
      method: 'POST',
      body: JSON.stringify({ fileSizeMb: 20 }),
      headers: { 'Content-Type': 'application/json' },
    })
    const handler = vi.fn(async () => Response.json({ ok: true }))

    const response = await mppCharge(
      request,
      node,
      { amount: async (req) => {
        const body = await req.json() as { fileSizeMb: number }
        return body.fileSizeMb * 50
      }},
      handler,
    )

    expect(response.status).toBe(402)
    expect(node.createMppChallenge).toHaveBeenCalledWith(1000) // 20 * 50
  })

  it('returns 500 when createMppChallenge throws', async () => {
    const node = createMockNode({
      createMppChallenge: vi.fn(async () => { throw new Error('MDK API down') }),
    })
    const request = new Request('https://example.com/api')
    const handler = vi.fn()

    const response = await mppCharge(request, node, { amount: 100 }, handler)

    expect(response.status).toBe(500)
    const body = await response.json() as Record<string, unknown>
    expect(body.error).toBe('Internal server error')
    expect(handler).not.toHaveBeenCalled()
  })

  it('returns 500 when verifyMppCredential throws', async () => {
    const node = createMockNode({
      verifyMppCredential: vi.fn(async () => { throw new Error('storage error') }),
    })
    const payload = base64urlEncode(JSON.stringify({ preimage: 'dd'.repeat(32) }))
    const request = new Request('https://example.com/api', {
      headers: { Authorization: `Payment id="test-id",payload="${payload}"` },
    })
    const handler = vi.fn()

    const response = await mppCharge(request, node, { amount: 100 }, handler)

    expect(response.status).toBe(500)
    expect(handler).not.toHaveBeenCalled()
  })

  it('returns 402 for malformed Authorization header', async () => {
    const node = createMockNode()
    const request = new Request('https://example.com/api', {
      headers: { Authorization: 'Bearer some-token' },
    })
    const handler = vi.fn()

    const response = await mppCharge(request, node, { amount: 100 }, handler)

    // Non-Payment scheme treated as no credential → issue challenge
    expect(response.status).toBe(402)
    expect(node.createMppChallenge).toHaveBeenCalledWith(100)
  })
})
