import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('ldk-wasm/ldk_wasm_bg.wasm', () => ({ default: {} }))
vi.mock('ldk-wasm', () => ({
  initSync: vi.fn(),
  process_peer_message: vi.fn(),
  queue_lsps4_register: vi.fn(),
  notify_socket_disconnected: vi.fn(),
  signal_monitors_persisted: vi.fn(),
}))

import {
  process_peer_message,
  queue_lsps4_register,
  signal_monitors_persisted,
} from 'ldk-wasm'

import { pumpLoop } from './pump-loop.js'
import type { NodeStorage } from './storage.js'

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

function createMockSocket(reads: Array<Uint8Array | null>) {
  return {
    read: vi.fn(async () => reads.shift() ?? new Uint8Array(0)),
    write: vi.fn<(data: Uint8Array) => Promise<void>>().mockResolvedValue(undefined),
    close: vi.fn(),
  }
}

function baseResult() {
  return {
    outbound: '',
    peerReady: false,
    channelsReady: false,
    claimedPayments: [],
    disconnected: false,
    pendingPersists: [],
    pendingDeletes: [],
  }
}

describe('pumpLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('durably handles the final timeout flush before returning', async () => {
    vi.mocked(process_peer_message).mockReturnValueOnce(JSON.stringify({
      ...baseResult(),
      claimedPayments: [{ payment_hash: 'hash-1', amount_msat: 2_000 }],
      pendingPersists: [{
        key: 'monitors/recovery',
        channelId: '11'.repeat(32),
        updateId: 7,
        data: 'cafe',
      }],
    }))

    const storage = createMockStorage()
    const socket = createMockSocket([])
    const result = await pumpLoop(socket, storage, { timeoutMs: -1 })

    expect(storage.put).toHaveBeenCalledWith({
      'monitors/recovery': new Uint8Array([0xca, 0xfe]),
    })
    expect(storage.sync).toHaveBeenCalledTimes(1)
    expect(signal_monitors_persisted).toHaveBeenCalledWith(JSON.stringify([{
      channelId: '11'.repeat(32),
      updateId: 7,
    }]))
    expect(result.allClaimed).toEqual([{ payment_hash: 'hash-1', amount_msat: 2_000 }])
  })

  it('persists callback-triggered flushes before returning a terminal payment outcome', async () => {
    vi.mocked(process_peer_message)
      .mockReturnValueOnce(JSON.stringify({
        ...baseResult(),
        channelsReady: true,
      }))
      .mockReturnValueOnce(JSON.stringify({
        ...baseResult(),
        outbound: 'abcd',
        channelsReady: true,
        pendingPersists: [{
          key: 'monitors/payment',
          channelId: '22'.repeat(32),
          updateId: 9,
          data: '0102',
        }],
        paymentOutcome: {
          type: 'sent',
          paymentHash: 'payment-hash',
          preimage: 'preimage',
        },
      }))

    const storage = createMockStorage()
    const socket = createMockSocket([new Uint8Array([1, 2, 3])])
    const onChannelsReady = vi.fn()

    const result = await pumpLoop(socket, storage, { onChannelsReady })

    expect(onChannelsReady).toHaveBeenCalledTimes(1)
    expect(socket.write).toHaveBeenCalledWith(new Uint8Array([0xab, 0xcd]))
    expect(storage.put).toHaveBeenCalledWith({
      'monitors/payment': new Uint8Array([1, 2]),
    })
    expect(signal_monitors_persisted).toHaveBeenCalledWith(JSON.stringify([{
      channelId: '22'.repeat(32),
      updateId: 9,
    }]))
    expect(result.paymentOutcome).toEqual({
      type: 'sent',
      paymentHash: 'payment-hash',
      preimage: 'preimage',
    })
  })

  it('surfaces LSPS4 registration errors immediately instead of timing out', async () => {
    vi.mocked(process_peer_message)
      .mockReturnValueOnce(JSON.stringify({
        ...baseResult(),
        peerReady: true,
      }))
      .mockReturnValueOnce(JSON.stringify({
        ...baseResult(),
        registrationError: 'rate limited',
      }))

    const storage = createMockStorage()
    const socket = createMockSocket([new Uint8Array([5])])

    await expect(pumpLoop(socket, storage, { waitForRegistration: true }))
      .rejects.toThrow('LSPS4 registration failed: rate limited')
    expect(queue_lsps4_register).toHaveBeenCalledTimes(1)
  })
})
