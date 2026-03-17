import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('ldk-wasm/ldk_wasm_bg.wasm', () => ({ default: {} }))
vi.mock('ldk-wasm', () => ({
  initSync: vi.fn(),
  signal_monitors_persisted: vi.fn(),
}))

import { flushPendingMonitors, refreshFees, type NodeStorage } from './storage.js'
import { signal_monitors_persisted } from 'ldk-wasm'

function createMockStorage(): NodeStorage {
  return {
    put: vi.fn<(entries: Record<string, unknown>) => Promise<void>>().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(0),
    list: vi.fn().mockResolvedValue(new Map()),
    sync: vi.fn().mockResolvedValue(undefined),
    deleteAll: vi.fn().mockResolvedValue(undefined),
  }
}

describe('refreshFees', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  it('fetches fees and caches them in storage', async () => {
    const feeJson = '{"1":50,"3":25,"6":10}'
    fetchSpy.mockResolvedValueOnce(new Response(feeJson))

    const storage = createMockStorage()
    const result = await refreshFees('https://esplora.example.com', storage)

    expect(result).toBe(feeJson)
    expect(fetchSpy).toHaveBeenCalledWith('https://esplora.example.com/fee-estimates')
    expect(storage.put).toHaveBeenCalledWith(
      expect.objectContaining({ fee_estimates: feeJson })
    )
    // Also stores the timestamp
    const putArg = vi.mocked(storage.put).mock.calls[0][0]
    expect(putArg).toHaveProperty('fee_estimates_updated_at')
    expect(typeof putArg.fee_estimates_updated_at).toBe('number')
  })

  it('throws on HTTP error response', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('Server Error', { status: 500 }))

    const storage = createMockStorage()
    await expect(refreshFees('https://esplora.example.com', storage))
      .rejects.toThrow('Fee estimate fetch failed: HTTP 500')

    expect(storage.put).not.toHaveBeenCalled()
  })

  it('throws on 404 response', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('Not Found', { status: 404 }))

    const storage = createMockStorage()
    await expect(refreshFees('https://esplora.example.com', storage))
      .rejects.toThrow('Fee estimate fetch failed: HTTP 404')
  })

  it('returns the fee JSON string directly', async () => {
    const feeJson = '{"2":100}'
    fetchSpy.mockResolvedValueOnce(new Response(feeJson))

    const storage = createMockStorage()
    const result = await refreshFees('https://mempool.space/api', storage)

    expect(result).toBe(feeJson)
    expect(fetchSpy).toHaveBeenCalledWith('https://mempool.space/api/fee-estimates')
  })
})

describe('flushPendingMonitors', () => {
  it('signals every completed update even when multiple updates share one monitor write', async () => {
    const storage = createMockStorage()

    await flushPendingMonitors(storage, [
      {
        key: 'monitors/shared',
        channelId: 'aa'.repeat(32),
        updateId: 1,
        data: '0102',
      },
      {
        key: 'monitors/shared',
        channelId: 'aa'.repeat(32),
        updateId: 2,
        data: '0102',
      },
    ], [])

    expect(storage.put).toHaveBeenCalledWith({
      'monitors/shared': new Uint8Array([1, 2]),
    })
    expect(storage.sync).toHaveBeenCalledTimes(1)
    expect(signal_monitors_persisted).toHaveBeenCalledWith(JSON.stringify([
      { channelId: 'aa'.repeat(32), updateId: 1 },
      { channelId: 'aa'.repeat(32), updateId: 2 },
    ]))
  })
})
