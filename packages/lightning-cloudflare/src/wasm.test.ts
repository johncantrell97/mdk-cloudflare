import { describe, it, expect, vi } from 'vitest'

vi.mock('ldk-wasm/ldk_wasm_bg.wasm', () => ({ default: {} }))
vi.mock('ldk-wasm', () => ({ initSync: vi.fn() }))

import { hexToBytes, parseInvoiceDetails } from './wasm.js'

describe('hexToBytes', () => {
  it('returns empty Uint8Array for empty string', () => {
    const result = hexToBytes('')
    expect(result).toBeInstanceOf(Uint8Array)
    expect(result.length).toBe(0)
  })

  it('converts simple hex pairs', () => {
    const result = hexToBytes('0102ff')
    expect(result).toEqual(new Uint8Array([1, 2, 255]))
  })

  it('converts known value deadbeef', () => {
    const result = hexToBytes('deadbeef')
    expect(result).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))
  })

  it('handles all zeros', () => {
    const result = hexToBytes('000000')
    expect(result).toEqual(new Uint8Array([0, 0, 0]))
  })

  it('truncates odd-length hex (last nibble ignored)', () => {
    // hex.length is 3 → bytes array length is 1 (Math.floor(3/2))
    // loop runs i=0,2 → bytes[0]=0xab, i=2 tries substr(2,2)="c" → parseInt("c",16)=12
    // but bytes has length 1 so bytes[1] is out of bounds (no-op on typed array)
    const result = hexToBytes('abc')
    expect(result.length).toBe(1)
    expect(result[0]).toBe(0xab)
  })

  it('converts uppercase hex', () => {
    const result = hexToBytes('AABB')
    expect(result).toEqual(new Uint8Array([0xaa, 0xbb]))
  })
})

describe('parseInvoiceDetails', () => {
  it('parses valid JSON and maps fields', () => {
    const json = JSON.stringify({
      invoice: 'lnbc100u1ptest',
      paymentHash: 'abc123',
      expiresAt: 1700000000,
      scid: '800000x0x0',
    })
    const result = parseInvoiceDetails(json)
    expect(result).toEqual({
      bolt11: 'lnbc100u1ptest',
      paymentHash: 'abc123',
      expiresAt: 1700000000,
      scid: '800000x0x0',
    })
  })

  it('maps invoice field to bolt11', () => {
    const json = JSON.stringify({
      invoice: 'lnbc500n1pmyinvoice',
      paymentHash: 'ff00',
      expiresAt: 9999999999,
      scid: '123x456x789',
    })
    const result = parseInvoiceDetails(json)
    expect(result.bolt11).toBe('lnbc500n1pmyinvoice')
    expect(result).not.toHaveProperty('invoice')
  })

  it('preserves all PaymentMetadata fields', () => {
    const json = JSON.stringify({
      invoice: 'lnbc1p',
      paymentHash: 'deadbeef',
      expiresAt: 0,
      scid: '0x0x0',
    })
    const result = parseInvoiceDetails(json)
    expect(Object.keys(result).sort()).toEqual(['bolt11', 'expiresAt', 'paymentHash', 'scid'])
  })

  it('throws on invalid JSON', () => {
    expect(() => parseInvoiceDetails('not json')).toThrow()
  })
})
