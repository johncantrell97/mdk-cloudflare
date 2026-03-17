import {
  process_peer_message,
  queue_lsps4_register,
  notify_socket_disconnected,
} from 'ldk-wasm'

import { hexToBytes } from './wasm.js'
import { flushPendingMonitors } from './storage.js'
import type { NodeStorage } from './storage.js'
import { log } from './log.js'

interface PumpStepResult {
  outbound: string // hex
  peerReady: boolean
  channelsReady: boolean
  registration?: {
    interceptScid: string  // String to avoid f64 precision loss (SCIDs exceed 2^53)
    cltvExpiryDelta: number
  }
  registrationError?: string
  claimedPayments: Array<{ payment_hash: string; amount_msat: number }>
  paymentOutcome?: {
    type: 'sent' | 'failed'
    paymentHash: string
    preimage?: string
    reason?: string
  }
  disconnected: boolean
  pendingPersists: Array<{ key: string; channelId: string; updateId: number; data: string }>
  pendingDeletes: string[]
}

export type { PumpStepResult }

export interface PumpLoopOptions {
  waitForRegistration?: boolean
  waitForClaims?: boolean
  waitForPayment?: boolean
  timeoutMs?: number
  quietTimeoutMs?: number
  onChannelsReady?: () => void
}

export type PumpLoopResult = PumpStepResult & { allClaimed: Array<{ payment_hash: string; amount_msat: number }> }

/**
 * JS-driven TCP pump loop. Handles all async I/O while WASM processes
 * messages synchronously. This mirrors lightning-net-tokio's architecture.
 */
export async function pumpLoop(
  socket: { read: () => Promise<Uint8Array | null>; write: (data: Uint8Array) => Promise<void>; close: () => void },
  storage: NodeStorage,
  options: PumpLoopOptions,
): Promise<PumpLoopResult> {
  const start = Date.now()
  const timeout = options.timeoutMs ?? 25_000
  const quietTimeoutMs = options.quietTimeoutMs ?? 10_000
  let peerReadyHandled = false
  let channelsReadyHandled = false
  let iterations = 0
  let lastEventTime = Date.now()
  const allClaimed: Array<{ payment_hash: string; amount_msat: number }> = []

  // Handle claimed payments: accumulate (monitors already flushed inline by InProgress flow)
  function handleClaimed(claimed: typeof allClaimed) {
    if (claimed.length === 0) return
    allClaimed.push(...claimed)
    lastEventTime = Date.now()
  }

  async function applyPumpResult(result: PumpStepResult): Promise<PumpStepResult> {
    if (result.pendingPersists?.length > 0 || result.pendingDeletes?.length > 0) {
      await flushPendingMonitors(storage, result.pendingPersists, result.pendingDeletes)
    }

    if (result.outbound) {
      await socket.write(hexToBytes(result.outbound))
    }

    handleClaimed(result.claimedPayments)
    return result
  }

  async function processStep(inbound: Uint8Array): Promise<PumpStepResult> {
    const result = JSON.parse(process_peer_message(inbound)) as PumpStepResult
    return applyPumpResult(result)
  }

  function terminalResult(result: PumpStepResult): PumpLoopResult | null {
    if (result.registrationError) {
      throw new Error(`LSPS4 registration failed: ${result.registrationError}`)
    }

    if (options.waitForRegistration && result.registration) {
      log.info(`[pump] got LSPS4 registration: scid=${result.registration.interceptScid}`)
      return { ...result, allClaimed }
    }

    if (result.paymentOutcome) {
      log.info(`[pump] payment outcome: ${result.paymentOutcome.type}`)
      return { ...result, allClaimed }
    }

    if (result.disconnected) {
      log.warn('[pump] peer disconnected')
      return { ...result, allClaimed }
    }

    return null
  }

  // Flush pending outbound messages from WASM and durably handle any side-effects.
  async function flushPending() {
    return processStep(new Uint8Array(0))
  }

  while (true) {
    iterations++
    const now = Date.now()

    if (now - start > timeout) {
      log.info(`[pump] timeout after ${timeout}ms, ${iterations} iterations, ${allClaimed.length} claimed`)
      const finalResult = await flushPending()
      const terminal = terminalResult(finalResult)
      if (terminal) return terminal
      return { ...finalResult, allClaimed }
    }

    // Quiet timeout: exit after a quiet period once we have claims
    if (options.waitForClaims && allClaimed.length > 0 && now - lastEventTime > quietTimeoutMs) {
      log.debug(`[pump] quiet timeout after ${quietTimeoutMs}ms with ${allClaimed.length} claimed`)
      const finalResult = await flushPending()
      const terminal = terminalResult(finalResult)
      if (terminal) return terminal
      return { ...finalResult, allClaimed }
    }

    // Read from socket:
    // - null means socket closed (reader.read() returned done:true)
    // - empty Uint8Array means read timeout (200ms)
    // - Uint8Array with data means actual bytes received
    const bytes = await socket.read()

    if (bytes === null) {
      // Socket closed by remote
      log.warn(`[pump] socket closed by remote after ${iterations} iterations`)
      try { notify_socket_disconnected() } catch { /* session may be gone */ }
      return {
        outbound: '',
        peerReady: false,
        channelsReady: false,
        claimedPayments: [],
        disconnected: true,
        pendingPersists: [],
        pendingDeletes: [],
        allClaimed,
      }
    }

    if (bytes.length === 0) {
      // Read timeout — process events without new data (may have pending outbound)
      const result = await flushPending()
      const terminal = terminalResult(result)
      if (terminal) return terminal
      continue
    }

    // Got actual data — copy to fresh buffer (CF Workers may detach ReadableStream buffers)
    const inbound = new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    if (iterations <= 5) {
      log.debug(`[pump] iter=${iterations} inbound=${inbound.length}b`)
    }

    // Process through WASM synchronously
    let resultJson: string
    try {
      resultJson = process_peer_message(inbound)
    } catch (err) {
      log.error(`[pump] process_peer_message failed: ${err instanceof Error ? `${err.message}\n${err.stack}` : err}`)
      throw err
    }
    const result = await applyPumpResult(JSON.parse(resultJson) as PumpStepResult)
    if (result.outbound && iterations <= 5) {
      log.debug(`[pump] iter=${iterations} outbound=${hexToBytes(result.outbound).length}b peer_ready=${result.peerReady}`)
    }

    // Once peer is ready, send LSPS4 registration (only needs peer Init exchange)
    if (result.peerReady && !peerReadyHandled) {
      if (options.waitForRegistration) {
        log.info('[pump] peer ready, sending LSPS4 register')
        queue_lsps4_register()
        const flushResult = await flushPending()
        const terminal = terminalResult(flushResult)
        if (terminal) return terminal
      }
      peerReadyHandled = true
    }

    // Once channels are usable (channel_reestablish complete), fire payment callback
    if (result.channelsReady && !channelsReadyHandled) {
      if (options.onChannelsReady) {
        log.debug('[pump] channels ready, calling onChannelsReady callback')
        options.onChannelsReady()
        const flushResult = await flushPending()
        const terminal = terminalResult(flushResult)
        if (terminal) return terminal
      }
      channelsReadyHandled = true
    }

    // Check completion conditions
    const terminal = terminalResult(result)
    if (terminal) return terminal
  }
}
