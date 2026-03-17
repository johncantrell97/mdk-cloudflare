import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('ldk-wasm/ldk_wasm_bg.wasm', () => ({ default: {} }))
vi.mock('ldk-wasm', () => ({
  initSync: vi.fn(),
  derive_node_id: vi.fn(() => '02'.padEnd(66, '0')),
  setup_node: vi.fn(),
  initiate_connection: vi.fn(),
  create_invoice_on_session: vi.fn(),
  prepare_for_claiming: vi.fn(),
  timer_tick: vi.fn(),
  teardown_node: vi.fn(),
  prepare_for_sending: vi.fn(),
  sync_chain_on_session: vi.fn(),
  flush_broadcasts_on_session: vi.fn(),
  prepare_pending_monitor_recovery: vi.fn(() => '[]'),
  process_peer_message: vi.fn(),
  queue_lsps4_register: vi.fn(),
  notify_socket_disconnected: vi.fn(),
  signal_monitors_persisted: vi.fn(),
  needs_persistence: vi.fn(() => false),
  serialize_channel_manager: vi.fn(() => new Uint8Array([])),
  list_pending_monitor_updates: vi.fn(() => '[]'),
  get_info_on_session: vi.fn(() => JSON.stringify({ total_balance_msat: 0, channels: [] })),
  serialize_sweepable_outputs: vi.fn(() => new Uint8Array([])),
  take_pending_persists: vi.fn(() => JSON.stringify({ persists: [], deletes: [] })),
}))
vi.mock('./bindings.js', () => ({
  createFetcher: vi.fn(() => ({})),
  createConnector: vi.fn(() => ({
    connect: vi.fn(),
  })),
}))
vi.mock('./wasm.js', () => ({
  ensureWasm: vi.fn(),
  hexToBytes: (hex: string) => {
    const bytes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16)
    }
    return bytes
  },
  parseInvoiceDetails: vi.fn(),
}))

import {
  get_info_on_session,
  process_peer_message,
  prepare_pending_monitor_recovery,
  serialize_channel_manager,
  setup_node,
  signal_monitors_persisted,
  take_pending_persists,
  initiate_connection,
  teardown_node,
} from 'ldk-wasm'

import { createConnector } from './bindings.js'
import { MdkNode } from './node.js'
import type { MdkNodeOptions } from './types.js'
import type { NodeStorage } from './storage.js'

function createMockStorage(overrides: Partial<NodeStorage> = {}): NodeStorage {
  return {
    put: vi.fn<(entries: Record<string, unknown>) => Promise<void>>().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(0),
    list: vi.fn().mockResolvedValue(new Map()),
    sync: vi.fn().mockResolvedValue(undefined),
    deleteAll: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function createNode(storage: NodeStorage): MdkNode {
  const options: MdkNodeOptions & { storage: NodeStorage } = {
    network: 'signet',
    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    mdkApiKey: 'test-key',
    esploraUrl: 'https://esplora.example.com',
    rgsUrl: 'https://rgs.example.com',
    lspNodeId: '02'.padEnd(66, '1'),
    lspAddress: '127.0.0.1:9735',
    storage,
  }
  return new MdkNode(options)
}

describe('MdkNode restore safety', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(setup_node).mockImplementation(() => undefined)
    vi.mocked(prepare_pending_monitor_recovery).mockReturnValue('[]')
    vi.mocked(get_info_on_session).mockReturnValue(JSON.stringify({ total_balance_msat: 0, channels: [] }))
    vi.mocked(take_pending_persists).mockReturnValue(JSON.stringify({ persists: [], deletes: [] }))
    vi.mocked(serialize_channel_manager).mockReturnValue(new Uint8Array([]))
    vi.mocked(initiate_connection).mockReturnValue('')
  })

  it('fails closed on decode errors without deleting storage', async () => {
    vi.mocked(setup_node).mockImplementation(() => {
      throw new Error('Monitor decode failed: corrupted')
    })

    const storage = createMockStorage({
      list: vi.fn().mockResolvedValue(new Map([['monitors/test', new Uint8Array([1])]])),
      get: vi.fn((key: string) => {
        if (key === 'fee_estimates') return Promise.resolve('{"1":1}')
        if (key === 'fee_estimates_updated_at') return Promise.resolve(Date.now())
        if (key === 'channel_manager') return Promise.resolve(new Uint8Array([2]))
        return Promise.resolve(undefined)
      }),
    })

    await expect(createNode(storage).getNodeInfo())
      .rejects.toThrow('Failed to restore persisted node state')
    expect(storage.deleteAll).not.toHaveBeenCalled()
  })

  it('re-persists pending monitors during startup recovery before continuing', async () => {
    vi.mocked(prepare_pending_monitor_recovery).mockReturnValue(JSON.stringify([{
      key: 'monitors/recovered',
      channelId: '33'.repeat(32),
      updateId: 12,
      data: 'deadbeef',
    }]))
    vi.mocked(get_info_on_session).mockReturnValue(JSON.stringify({
      total_balance_msat: 5_000,
      channels: [],
    }))
    vi.mocked(take_pending_persists).mockReturnValue(JSON.stringify({ persists: [], deletes: [] }))
    vi.mocked(serialize_channel_manager).mockReturnValue(new Uint8Array([9, 9]))

    const storage = createMockStorage({
      get: vi.fn((key: string) => {
        if (key === 'fee_estimates') return Promise.resolve('{"1":1}')
        if (key === 'fee_estimates_updated_at') return Promise.resolve(Date.now())
        return Promise.resolve(undefined)
      }),
    })

    const info = await createNode(storage).getNodeInfo()

    expect(info.balanceSats).toBe(5)
    expect(storage.put).toHaveBeenNthCalledWith(1, {
      'monitors/recovered': new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    })
    expect(signal_monitors_persisted).toHaveBeenCalledWith(JSON.stringify([{
      channelId: '33'.repeat(32),
      updateId: 12,
    }]))
    expect(teardown_node).toHaveBeenCalled()
  })

  it('attempts a final ChannelManager persist when a post-restore operation fails', async () => {
    vi.mocked(get_info_on_session).mockImplementation(() => {
      throw new Error('boom')
    })
    vi.mocked(serialize_channel_manager).mockReturnValue(new Uint8Array([7, 8, 9]))

    const storage = createMockStorage({
      get: vi.fn((key: string) => {
        if (key === 'fee_estimates') return Promise.resolve('{"1":1}')
        if (key === 'fee_estimates_updated_at') return Promise.resolve(Date.now())
        return Promise.resolve(undefined)
      }),
    })

    await expect(createNode(storage).getNodeInfo()).rejects.toThrow('boom')

    expect(storage.put).toHaveBeenCalledWith({
      channel_manager: new Uint8Array([7, 8, 9]),
    })
    expect(storage.sync).toHaveBeenCalledTimes(1)
    expect(teardown_node).toHaveBeenCalled()
  })

  it('persists the ChannelManager after a transport failure that happens after monitor durability', async () => {
    vi.mocked(process_peer_message).mockReturnValue(JSON.stringify({
      outbound: 'abcd',
      peerReady: false,
      channelsReady: false,
      claimedPayments: [],
      disconnected: false,
      pendingPersists: [{
        key: 'monitors/inflight',
        channelId: '44'.repeat(32),
        updateId: 21,
        data: 'beef',
      }],
      pendingDeletes: [],
    }))
    vi.mocked(serialize_channel_manager).mockReturnValue(new Uint8Array([4, 5, 6]))

    const socket = {
      read: vi.fn(async () => new Uint8Array([1, 2, 3])),
      write: vi.fn<(data: Uint8Array) => Promise<void>>()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('write failed')),
      close: vi.fn(),
    }
    vi.mocked(createConnector).mockReturnValue({
      connect: vi.fn(async () => socket),
    } as ReturnType<typeof createConnector>)

    const storage = createMockStorage({
      get: vi.fn((key: string) => {
        if (key === 'fee_estimates') return Promise.resolve('{"1":1}')
        if (key === 'fee_estimates_updated_at') return Promise.resolve(Date.now())
        return Promise.resolve(undefined)
      }),
    })

    await expect(createNode(storage).receivePayments()).rejects.toThrow('write failed')

    expect(storage.put).toHaveBeenNthCalledWith(1, {
      'monitors/inflight': new Uint8Array([0xbe, 0xef]),
    })
    expect(signal_monitors_persisted).toHaveBeenCalledWith(JSON.stringify([{
      channelId: '44'.repeat(32),
      updateId: 21,
    }]))
    expect(storage.put).toHaveBeenNthCalledWith(2, {
      channel_manager: new Uint8Array([4, 5, 6]),
    })
    expect(storage.sync).toHaveBeenCalledTimes(2)
    expect(teardown_node).toHaveBeenCalled()
  })
})
