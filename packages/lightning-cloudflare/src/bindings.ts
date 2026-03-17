/**
 * Cloudflare Workers bindings that satisfy the WASM extern interfaces.
 *
 * The Rust WASM module calls methods directly on the objects passed in:
 * - Fetcher: .get_json(url), .get_text(url), .get_bytes(url), .post_bytes(url, bytes)
 * - Connector: .connect(host, port) -> {read, write, close}
 */

import { log } from './log.js'

export function createFetcher() {
  return {
    get_json: async (url: string): Promise<unknown> => {
      log.debug(`[fetch] GET ${url}`)
      const resp = await fetch(url)
      log.debug(`[fetch] GET ${url} -> ${resp.status}`)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`)
      return resp.json()
    },
    get_text: async (url: string): Promise<string> => {
      log.debug(`[fetch] GET ${url}`)
      const resp = await fetch(url)
      log.debug(`[fetch] GET ${url} -> ${resp.status}`)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`)
      return resp.text()
    },
    post_bytes: async (url: string, body: Uint8Array): Promise<string> => {
      const resp = await fetch(url, { method: 'POST', body })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`)
      return resp.text()
    },
    get_bytes: async (url: string): Promise<Uint8Array> => {
      const resp = await fetch(url)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`)
      const buf = await resp.arrayBuffer()
      return new Uint8Array(buf)
    },
  }
}

export function createConnector() {
  return {
    connect: async (host: string, port: number) => {
      const { connect } = await import('cloudflare:sockets' as string)
      const socket = connect({ hostname: host, port }, { secureTransport: 'off' })
      await socket.opened
      const reader = socket.readable.getReader()
      const writer = socket.writable.getWriter()
      // CF Workers only allows one pending reader.read() at a time.
      // Cache the pending read so timeouts don't leave a dangling promise.
      let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null
      return {
        read: async (): Promise<Uint8Array | null> => {
          const timeout = new Promise<null>(r => setTimeout(() => r(null), 200))
          if (!pendingRead) {
            pendingRead = reader.read()
          }
          const result = await Promise.race([pendingRead, timeout])
          if (result === null) {
            return new Uint8Array(0)
          }
          pendingRead = null
          return result.done ? null : result.value
        },
        write: async (data: Uint8Array): Promise<void> => {
          await writer.write(data)
        },
        close: (): void => {
          socket.close()
        },
      }
    },
  }
}
