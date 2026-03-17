import { signal_monitors_persisted } from 'ldk-wasm'
import { hexToBytes } from './wasm.js'

export interface NodeStorage {
  put(entries: Record<string, unknown>): Promise<void>
  get<T = unknown>(key: string): Promise<T | undefined>
  delete(keys: string[]): Promise<number>
  list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>
  sync(): Promise<void>
  deleteAll(): Promise<void>
}

/**
 * Fetch fee estimates from Esplora and cache in DO storage.
 * Shared by the alarm handler and setupFromStorage fallback.
 */
export async function refreshFees(esploraUrl: string, storage: NodeStorage): Promise<string> {
  const feeResp = await fetch(`${esploraUrl}/fee-estimates`)
  if (!feeResp.ok) throw new Error(`Fee estimate fetch failed: HTTP ${feeResp.status}`)
  const feeJson = await feeResp.text()
  // Don't await — caching is for future requests, no need to block current setup
  storage.put({ fee_estimates: feeJson, fee_estimates_updated_at: Date.now() })
  return feeJson
}

/**
 * Flush pending monitor writes to DO storage and signal completion to WASM.
 * Called between pump loop iterations and after chain sync.
 */
export async function flushPendingMonitors(
  storage: NodeStorage,
  pendingPersists: Array<{ key: string; channelId: string; updateId: number; data: string }>,
  pendingDeletes: string[],
) {
  if (pendingPersists.length === 0 && pendingDeletes.length === 0) return

  const entries: Record<string, Uint8Array> = {}
  for (const p of pendingPersists) {
    entries[p.key] = hexToBytes(p.data)
  }

  await storage.put(entries)
  if (pendingDeletes.length > 0) {
    await storage.delete(pendingDeletes)
  }
  await storage.sync()

  const completed = pendingPersists.map(p => ({
    channelId: p.channelId,
    updateId: p.updateId,
  }))
  signal_monitors_persisted(JSON.stringify(completed))
}
