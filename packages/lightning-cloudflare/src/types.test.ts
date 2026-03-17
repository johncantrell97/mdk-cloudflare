import { describe, expect, it } from 'vitest'
import { PaymentEventType } from './types.js'

describe('PaymentEventType', () => {
  it('is available as a runtime enum for public imports', () => {
    expect(PaymentEventType.Claimable).toBe(0)
    expect(PaymentEventType.Sent).toBe(3)
    expect(PaymentEventType[PaymentEventType.Received]).toBe('Received')
  })
})
