import { describe, it, expect, vi } from 'vitest'
import { parseDestinationToUrl, parseBolt11AmountMsat, resolveDestinationToInvoice } from './lnurl.js'

// --- Bech32 encoder for generating test vectors ---

const BECH32_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of values) {
    const b = chk >> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) {
      if ((b >> i) & 1) {
        chk ^= GEN[i]
      }
    }
  }
  return chk
}

function bech32HrpExpand(hrp: string): number[] {
  const ret: number[] = []
  for (const ch of hrp) {
    ret.push(ch.charCodeAt(0) >> 5)
  }
  ret.push(0)
  for (const ch of hrp) {
    ret.push(ch.charCodeAt(0) & 31)
  }
  return ret
}

function bech32CreateChecksum(hrp: string, data: number[]): number[] {
  const values = bech32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0])
  const polymod = bech32Polymod(values) ^ 1
  const ret: number[] = []
  for (let i = 0; i < 6; i++) {
    ret.push((polymod >> (5 * (5 - i))) & 31)
  }
  return ret
}

function convertBits8to5(data: Uint8Array): number[] {
  const result: number[] = []
  let acc = 0
  let bits = 0
  for (const byte of data) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      result.push((acc >> bits) & 31)
    }
  }
  if (bits > 0) {
    result.push((acc << (5 - bits)) & 31)
  }
  return result
}

function bech32Encode(hrp: string, data: Uint8Array): string {
  const fiveBit = convertBits8to5(data)
  const checksum = bech32CreateChecksum(hrp, fiveBit)
  const combined = fiveBit.concat(checksum)
  return hrp + '1' + combined.map(v => BECH32_ALPHABET[v]).join('')
}

// --- Tests ---

describe('parseDestinationToUrl', () => {
  it('converts a Lightning Address to a well-known URL', () => {
    const url = parseDestinationToUrl('user@example.com')
    expect(url).toBe('https://example.com/.well-known/lnurlp/user')
  })

  it('converts a Lightning Address with subdomain', () => {
    const url = parseDestinationToUrl('alice@pay.example.com')
    expect(url).toBe('https://pay.example.com/.well-known/lnurlp/alice')
  })

  it('decodes an LNURL bech32 string to a URL', () => {
    const originalUrl = 'https://example.com/lnurlp'
    const encoded = bech32Encode('lnurl', new TextEncoder().encode(originalUrl))
    expect(encoded.startsWith('lnurl1')).toBe(true)
    const decoded = parseDestinationToUrl(encoded)
    expect(decoded).toBe(originalUrl)
  })

  it('decodes an uppercase LNURL bech32 string', () => {
    const originalUrl = 'https://example.com/lnurlp'
    const encoded = bech32Encode('lnurl', new TextEncoder().encode(originalUrl))
    const decoded = parseDestinationToUrl(encoded.toUpperCase())
    expect(decoded).toBe(originalUrl)
  })

  it('throws on invalid destination format', () => {
    expect(() => parseDestinationToUrl('not-a-valid-destination')).toThrow(
      'Invalid WITHDRAWAL_DESTINATION format'
    )
  })

  it('throws on empty string', () => {
    expect(() => parseDestinationToUrl('')).toThrow(
      'Invalid WITHDRAWAL_DESTINATION format'
    )
  })
})

describe('parseBolt11AmountMsat', () => {
  it('parses milli-BTC (m suffix)', () => {
    expect(parseBolt11AmountMsat('lnbc10m1ps')).toBe(1_000_000_000n)
  })

  it('parses micro-BTC (u suffix)', () => {
    expect(parseBolt11AmountMsat('lnbc100u1ps')).toBe(10_000_000n)
  })

  it('parses nano-BTC (n suffix)', () => {
    expect(parseBolt11AmountMsat('lnbc1000n1ps')).toBe(100_000n)
  })

  it('parses pico-BTC (p suffix)', () => {
    // 10000 pico-BTC = 10^-8 BTC = 1 sat = 1000 msat
    expect(parseBolt11AmountMsat('lnbc10000p1ps')).toBe(1000n)
  })

  it('parses amount with digits containing 1', () => {
    expect(parseBolt11AmountMsat('lnbc1500u1ps')).toBe(150_000_000n)
  })

  it('returns null for invoice with no amount', () => {
    expect(parseBolt11AmountMsat('lnbc1ps')).toBeNull()
  })

  it('handles signet prefix (lntbs)', () => {
    expect(parseBolt11AmountMsat('lntbs100u1ps')).toBe(10_000_000n)
  })

  it('returns null for non-BOLT11 string', () => {
    expect(parseBolt11AmountMsat('notaninvoice')).toBeNull()
  })
})

describe('resolveDestinationToInvoice', () => {
  it('resolves a Lightning Address to a BOLT11 invoice', async () => {
    const mockInvoice = 'lnbc100u1pstestfakedata'
    const amountMsat = 10_000_000

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tag: 'payRequest',
        callback: 'https://example.com/lnurlp/user/callback',
        minSendable: 1_000,
        maxSendable: 100_000_000_000,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        pr: mockInvoice,
      })))

    const bolt11 = await resolveDestinationToInvoice('user@example.com', amountMsat)

    expect(bolt11).toBe(mockInvoice)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(fetchSpy).toHaveBeenNthCalledWith(1, 'https://example.com/.well-known/lnurlp/user', {
      headers: { 'Accept': 'application/json', 'User-Agent': 'mdk-cloudflare/1.0' },
    })
    expect(fetchSpy).toHaveBeenNthCalledWith(2, 'https://example.com/lnurlp/user/callback?amount=10000000', {
      headers: { 'Accept': 'application/json', 'User-Agent': 'mdk-cloudflare/1.0' },
    })

    fetchSpy.mockRestore()
  })

  it('throws when LNURL endpoint returns HTTP error', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockResolvedValueOnce(new Response('Not Found', { status: 404 }))

    await expect(resolveDestinationToInvoice('user@example.com', 10_000))
      .rejects.toThrow('LNURL resolution failed: HTTP 404')

    fetchSpy.mockRestore()
  })

  it('throws when callback returns HTTP error', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tag: 'payRequest',
        callback: 'https://example.com/callback',
        minSendable: 1_000,
        maxSendable: 100_000_000,
      })))
      .mockResolvedValueOnce(new Response('Server Error', { status: 500 }))

    await expect(resolveDestinationToInvoice('user@example.com', 10_000))
      .rejects.toThrow('LNURL resolution failed: callback HTTP 500')

    fetchSpy.mockRestore()
  })

  it('throws when LNURL response has no callback URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      tag: 'payRequest',
      minSendable: 1_000,
      maxSendable: 100_000_000,
    })))

    await expect(resolveDestinationToInvoice('user@example.com', 10_000))
      .rejects.toThrow('LNURL resolution failed: no callback URL')

    fetchSpy.mockRestore()
  })

  it('throws when tag is not payRequest', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      tag: 'withdrawRequest',
      callback: 'https://example.com/callback',
    })))

    await expect(resolveDestinationToInvoice('user@example.com', 10_000))
      .rejects.toThrow('LNURL endpoint is not a pay request')

    fetchSpy.mockRestore()
  })

  it('throws when amount is out of range', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      tag: 'payRequest',
      callback: 'https://example.com/callback',
      minSendable: 10_000,
      maxSendable: 50_000,
    })))

    await expect(resolveDestinationToInvoice('user@example.com', 100_000))
      .rejects.toThrow('outside allowed range')

    fetchSpy.mockRestore()
  })

  it('throws when callback returns ERROR status', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tag: 'payRequest',
        callback: 'https://example.com/callback',
        minSendable: 1_000,
        maxSendable: 100_000_000,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'ERROR',
        reason: 'something went wrong',
      })))

    await expect(resolveDestinationToInvoice('user@example.com', 10_000))
      .rejects.toThrow('LNURL callback error: something went wrong')

    fetchSpy.mockRestore()
  })

  it('throws when callback returns no pr field', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tag: 'payRequest',
        callback: 'https://example.com/callback',
        minSendable: 1_000,
        maxSendable: 100_000_000,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({})))

    await expect(resolveDestinationToInvoice('user@example.com', 10_000))
      .rejects.toThrow('LNURL callback did not return an invoice')

    fetchSpy.mockRestore()
  })

  it('throws on invoice amount mismatch', async () => {
    const wrongAmountInvoice = 'lnbc200u1pstestfakedata'

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tag: 'payRequest',
        callback: 'https://example.com/callback',
        minSendable: 1_000,
        maxSendable: 100_000_000,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        pr: wrongAmountInvoice,
      })))

    await expect(resolveDestinationToInvoice('user@example.com', 10_000_000))
      .rejects.toThrow('Invoice amount mismatch')

    fetchSpy.mockRestore()
  })
})
