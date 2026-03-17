import {
  derive_node_id,
  setup_node,
  initiate_connection,
  create_invoice_on_session,
  prepare_for_claiming,
  timer_tick,
  teardown_node,
  prepare_for_sending,
  sync_chain_on_session,
  flush_broadcasts_on_session,
  prepare_pending_monitor_recovery,
  serialize_channel_manager,
  get_info_on_session,
  serialize_sweepable_outputs,
  take_pending_persists,
} from 'ldk-wasm'

import { log } from './log.js'
import { createFetcher, createConnector } from './bindings.js'
import { ensureWasm, hexToBytes, parseInvoiceDetails } from './wasm.js'
import { refreshFees, flushPendingMonitors } from './storage.js'
import type { NodeStorage } from './storage.js'
import { pumpLoop } from './pump-loop.js'
import type {
  MdkNodeOptions,
  PaymentMetadata,
  PaymentEvent,
  PaymentResult,
  ReceivedPayment,
  NodeChannel,
  NodeInfo,
} from './types.js'

/**
 * Derive node ID without constructing an MdkNode.
 */
export function deriveNodeId(mnemonicStr: string, networkStr: string): string {
  ensureWasm()
  return derive_node_id(mnemonicStr, networkStr)
}

/**
 * Generate a BIP-39 mnemonic.
 * Stub — CF Workers should generate mnemonics server-side.
 */
export function generateMnemonic(): string {
  throw new Error('generateMnemonic() is not supported on CF Workers. Generate mnemonics server-side.')
}

/**
 * Set log listener. On CF Workers this is a no-op — logs go to console.
 */
export function setLogListener(_callback?: unknown, _minLevel?: string): void {
  // No-op on CF Workers — WASM logs via the logger object passed to each function
}

interface WasmChannelInfo {
  channel_id: string
  counterparty_node_id: string
  inbound_capacity_msat: number
  outbound_capacity_msat: number
  is_channel_ready: boolean
  is_usable: boolean
}

interface WasmNodeInfo {
  total_balance_msat: number
  channels?: WasmChannelInfo[]
}

/**
 * MdkNode-compatible class for Cloudflare Workers.
 *
 * Each operation follows: setupFromStorage() -> work -> persistSessionEnd() -> teardown_node().
 * State is persisted to Durable Object storage (monitors, ChannelManager, sweepable outputs).
 *
 * For operations requiring TCP (LSP registration, payment claiming), the async
 * event loop runs in JavaScript with sync WASM callbacks. This mirrors
 * lightning-net-tokio's architecture: JS handles async I/O, WASM processes
 * messages synchronously. No heavy WASM async state machines.
 */
export class MdkNode {
  private readonly network: string
  private readonly mnemonic: string
  private readonly esploraUrl: string
  private readonly lspPubkey: string
  private readonly lspHost: string
  private readonly lspPort: number
  private readonly rgsUrl: string
  private readonly lspCltvExpiryDelta: number
  private readonly storage: NodeStorage
  private destroyed = false

  constructor(options: MdkNodeOptions & { storage: NodeStorage }) {
    this.network = options.network
    this.mnemonic = options.mnemonic
    this.esploraUrl = options.esploraUrl
    this.lspPubkey = options.lspNodeId
    this.rgsUrl = options.rgsUrl || ''
    this.lspCltvExpiryDelta = options.lspCltvExpiryDelta ?? 72
    this.storage = options.storage

    const parts = options.lspAddress.split(':')
    this.lspHost = parts[0]
    this.lspPort = parts.length > 1 ? parseInt(parts[1], 10) : 9735

    ensureWasm()
  }

  private assertNotDestroyed() {
    if (this.destroyed) throw new Error('MdkNode has been destroyed')
  }

  // ── Storage-based setup & persistence ──────────────────────────────────

  /**
   * Read monitors + CM from DO storage, build node.
   * Uses cached fee estimates from DO storage (refreshed by alarm).
   * Falls back to inline Esplora fetch if no cache or cache older than 1 hour.
   */
  private lastRgsTimestamp = 0

  private async setupFromStorage() {
    const [monitors, cm, cachedFees, feeUpdatedAt, rgsTimestamp] = await Promise.all([
      this.storage.list<Uint8Array>({ prefix: 'monitors/' }),
      this.storage.get<Uint8Array>('channel_manager'),
      this.storage.get<string>('fee_estimates'),
      this.storage.get<number>('fee_estimates_updated_at'),
      this.storage.get<number>('rgs_timestamp'),
    ])
    this.lastRgsTimestamp = rgsTimestamp ?? 0

    // Use cached fees from DO storage. Fetch inline if:
    // - No cache exists (first request before alarm has run)
    // - Cache is older than 1 hour (alarm has been failing)
    const MAX_FEE_AGE_MS = 60 * 60 * 1000
    const feeStale = !feeUpdatedAt || (Date.now() - feeUpdatedAt > MAX_FEE_AGE_MS)

    let feeJson: string
    if (cachedFees && !feeStale) {
      feeJson = cachedFees
    } else {
      feeJson = await refreshFees(this.esploraUrl, this.storage)
    }

    const monitorEntries = Array.from(monitors.entries()).map(([key, data]) => ({
      key,
      data: Array.from(data),
    }))

    try {
      setup_node(
        JSON.stringify(monitorEntries),
        cm ? new Uint8Array(cm) : undefined,
        feeJson,
        this.mnemonic, this.network, this.esploraUrl,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to restore persisted node state: ${msg}`)
    }

    // Crash recovery: resolve any InProgress updates interrupted by a prior crash
    await this.recoverPendingUpdates()
  }

  /**
   * Crash recovery: re-persist any ChannelMonitor updates that were left InProgress.
   * The Rust side serializes the full current monitor bytes for each pending update,
   * and we only signal completion after those bytes are durably written.
   */
  private async recoverPendingUpdates() {
    const recoveryJson = prepare_pending_monitor_recovery()
    const persists: Array<{ key: string; channelId: string; updateId: number; data: string }>
      = JSON.parse(recoveryJson)

    if (persists.length > 0) {
      log.warn(`[setup] Recovering ${persists.length} pending monitor updates before startup`)
      await flushPendingMonitors(this.storage, persists, [])
    }
  }

  /**
   * Drain and flush any pending monitor writes to DO storage.
   * Used after chain sync and at session end before CM persistence.
   */
  private async drainAndFlushMonitors() {
    const pendingJson = take_pending_persists()
    const { persists, deletes } = JSON.parse(pendingJson)
    await flushPendingMonitors(this.storage, persists, deletes)
  }

  /**
   * End-of-session persistence: flush remaining monitors, then CM, then sweepable outputs.
   * Critical: monitors MUST be flushed before CM for LDK fund safety.
   * Always persists CM — get_and_clear_needs_persistence() is destructive (clears the flag),
   * so we always serialize to avoid losing state if the write were to fail.
   */
  private async persistSessionEnd() {
    // 1. Flush any remaining pending monitors (MUST happen before CM persist)
    await this.drainAndFlushMonitors()

    // 2. Always persist CM — the flag clear is destructive, and local DO writes are fast
    const entries: Record<string, unknown> = {}
    entries['channel_manager'] = serialize_channel_manager()

    // 3. Persist sweepable outputs if any were collected
    const sweepBytes = serialize_sweepable_outputs()
    if (sweepBytes.length > 0) {
      entries['sweepable_outputs'] = sweepBytes
    }

    await this.storage.put(entries)
    await this.storage.sync()
  }

  /**
   * Best-effort shutdown path for failures that occur after session restore.
   *
   * If monitor updates were durably flushed before the error, we still want one
   * last attempt to persist the ChannelManager before tearing down the session.
   */
  private async handleSessionFailure(sessionReady: boolean, context: string) {
    if (sessionReady) {
      try {
        await this.persistSessionEnd()
      } catch (persistErr) {
        const msg = persistErr instanceof Error ? persistErr.message : String(persistErr)
        log.error(`[${context}] Final session persistence failed: ${msg}`)
      }
    }

    try { teardown_node() } catch { /* ignore */ }
  }

  // ── Periodic maintenance (called by DO alarm) ──────────────────────────

  /**
   * Run chain sync, timer ticks, rebroadcast pending claims, flush, persist.
   * Called by the DO alarm handler every ~10 minutes.
   */
  async periodicMaintenance(): Promise<void> {
    const fetcher = createFetcher()
    let sessionReady = false
    try {
      await this.setupFromStorage()
      sessionReady = true
      await sync_chain_on_session(fetcher)
      await this.drainAndFlushMonitors()
      prepare_for_claiming()
      await flush_broadcasts_on_session(fetcher)
      await this.persistSessionEnd()
      teardown_node()
    } catch (err) {
      await this.handleSessionFailure(sessionReady, 'periodicMaintenance')
      throw err
    }
  }

  // ── Identity ─────────────────────────────────────────────────────────────

  getNodeId(): string {
    this.assertNotDestroyed()
    return derive_node_id(this.mnemonic, this.network)
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  start(): void { this.assertNotDestroyed() }
  stop(): void { this.assertNotDestroyed() }
  destroy(): void { this.destroyed = true }
  startReceiving(): void { this.assertNotDestroyed() }
  stopReceiving(): void { this.assertNotDestroyed() }

  // ── Invoices ───────────────────────────────────────────────────────────

  /**
   * Generate a BOLT11 invoice via LSPS4 registration with the LSP.
   * Mirrors lightning-js: always connects to LSP for fresh registration.
   */
  async getInvoice(amountMsat: number, description: string, expirySecs: number): Promise<PaymentMetadata> {
    this.assertNotDestroyed()
    const amountSats = Math.ceil(amountMsat / 1000)
    return this.registerAndCreateInvoice(amountSats, description, expirySecs)
  }

  async getInvoiceWhileRunning(amountMsat: number, description: string, expirySecs: number): Promise<PaymentMetadata> {
    return this.getInvoice(amountMsat, description, expirySecs)
  }

  /**
   * LSPS4 registration + invoice creation via the JS-driven pump loop.
   * Node is restored from DO storage, TCP I/O runs in JS, state persisted back to DO storage.
   */
  private async registerAndCreateInvoice(
    amountSats: number,
    description: string,
    expirySecs: number,
  ): Promise<PaymentMetadata> {
    const connector = createConnector()
    let sessionReady = false

    try {
      await this.setupFromStorage()
      sessionReady = true
      const socket = await connector.connect(this.lspHost, this.lspPort)
      const handshakeHex = initiate_connection(this.lspPubkey)
      await socket.write(hexToBytes(handshakeHex))

      const pumpResult = await pumpLoop(socket, this.storage, {
        waitForRegistration: true,
        timeoutMs: 15_000,
      })
      socket.close()

      if (!pumpResult.registration) {
        throw new Error('LSPS4 registration timed out')
      }

      const detailsStr = create_invoice_on_session(
        this.lspPubkey,
        pumpResult.registration.interceptScid,
        pumpResult.registration.cltvExpiryDelta,
        amountSats > 0 ? BigInt(amountSats) : undefined,
        description, expirySecs,
      )

      await flush_broadcasts_on_session(createFetcher())
      await this.persistSessionEnd()
      teardown_node()

      return parseInvoiceDetails(detailsStr)
    } catch (err) {
      await this.handleSessionFailure(sessionReady, 'getInvoice')
      throw err
    }
  }

  /**
   * Generate invoice using a known SCID string (e.g. from MDK API).
   * Session-based: setupFromStorage -> create invoice -> persist -> teardown.
   */
  async getInvoiceWithScid(scidStr: string, amountMsat: number, description: string, expirySecs: number): Promise<PaymentMetadata> {
    return this.createInvoiceWithScidSession(scidStr, BigInt(Math.ceil(amountMsat / 1000)), description, expirySecs)
  }

  async getVariableAmountJitInvoice(description: string, expirySecs: number): Promise<PaymentMetadata> {
    return this.getVariableAmountJitInvoiceWhileRunning(description, expirySecs)
  }

  async getVariableAmountJitInvoiceWhileRunning(description: string, expirySecs: number): Promise<PaymentMetadata> {
    this.assertNotDestroyed()
    return this.registerAndCreateInvoice(0, description, expirySecs)
  }

  async getVariableAmountJitInvoiceWithScid(scidStr: string, description: string, expirySecs: number): Promise<PaymentMetadata> {
    return this.createInvoiceWithScidSession(scidStr, undefined, description, expirySecs)
  }

  private async createInvoiceWithScidSession(
    scidStr: string, amountSats: bigint | undefined, description: string, expirySecs: number,
  ): Promise<PaymentMetadata> {
    this.assertNotDestroyed()
    let sessionReady = false

    try {
      await this.setupFromStorage()
      sessionReady = true
      const detailsStr = create_invoice_on_session(
        this.lspPubkey, scidStr, this.lspCltvExpiryDelta,
        amountSats !== undefined && amountSats > 0n ? amountSats : undefined,
        description, expirySecs,
      )
      const result = parseInvoiceDetails(detailsStr)
      await this.persistSessionEnd()
      teardown_node()
      return result
    } catch (err) {
      await this.handleSessionFailure(sessionReady, 'getInvoiceWithScid')
      throw err
    }
  }

  // ── Payments ─────────────────────────────────────────────────────────────

  async pay(destination: string, _amountMsat?: number, _waitForPaymentSecs?: number): Promise<PaymentResult> {
    this.assertNotDestroyed()
    if (!this.rgsUrl) {
      throw new Error('pay() requires rgsUrl in MdkNodeOptions')
    }
    const fetcher = createFetcher()
    const connector = createConnector()
    let sessionReady = false

    try {
      await this.setupFromStorage()
      sessionReady = true
      // Incremental RGS fetch (cached timestamp → small delta instead of full snapshot)
      const rgsTimestamp = this.lastRgsTimestamp
      let rgsData: Uint8Array
      let rgsWasReset = false
      try {
        log.debug(`[pay] fetching RGS snapshot from ${this.rgsUrl}/${rgsTimestamp}`)
        const rgsResp = await fetch(`${this.rgsUrl}/${rgsTimestamp}`)
        if (!rgsResp.ok) throw new Error(`HTTP ${rgsResp.status}`)
        rgsData = new Uint8Array(await rgsResp.arrayBuffer())
      } catch (e) {
        if (rgsTimestamp > 0) {
          log.warn(`[pay] RGS incremental failed (${e}), falling back to /0`)
          const rgsResp = await fetch(`${this.rgsUrl}/0`)
          if (!rgsResp.ok) throw new Error(`RGS fetch failed: HTTP ${rgsResp.status}`)
          rgsData = new Uint8Array(await rgsResp.arrayBuffer())
          rgsWasReset = true  // don't re-cache the stale timestamp
        } else {
          throw e
        }
      }
      log.debug(`[pay] RGS snapshot: ${rgsData.length} bytes`)

      timer_tick()  // lightweight timer ticks

      // Connect to LSP
      const socket = await connector.connect(this.lspHost, this.lspPort)
      const handshakeHex = initiate_connection(this.lspPubkey)
      await socket.write(hexToBytes(handshakeHex))

      // Pump: peer ready -> initiate payment -> wait for outcome
      let newRgsTimestamp = rgsTimestamp
      const pumpResult = await pumpLoop(socket, this.storage, {
        waitForPayment: true,
        timeoutMs: 25_000,
        onChannelsReady: () => {
          log.info('[pay] peer ready, initiating payment')
          const resultJson = prepare_for_sending(rgsData, destination)
          const result = JSON.parse(resultJson) as { paymentHash: string; rgsTimestamp: number }
          newRgsTimestamp = result.rgsTimestamp
          log.info(`[pay] payment initiated: hash=${result.paymentHash}`)
        },
      })
      socket.close()

      // Flush pending broadcasts + persist + teardown
      await flush_broadcasts_on_session(fetcher)

      // Cache RGS timestamp for next incremental fetch
      // If we fell back to /0, reset to the new timestamp from the full snapshot
      const tsToCache = rgsWasReset && newRgsTimestamp === rgsTimestamp ? 0 : newRgsTimestamp
      if (tsToCache !== rgsTimestamp) {
        this.lastRgsTimestamp = tsToCache
        await this.storage.put({ rgs_timestamp: tsToCache })
      }

      await this.persistSessionEnd()
      teardown_node()

      // Return result
      if (pumpResult.paymentOutcome?.type === 'sent') {
        return {
          paymentId: pumpResult.paymentOutcome.paymentHash,
          paymentHash: pumpResult.paymentOutcome.paymentHash,
          preimage: pumpResult.paymentOutcome.preimage ?? '',
        }
      } else if (pumpResult.paymentOutcome?.type === 'failed') {
        throw new Error(`Payment failed: ${pumpResult.paymentOutcome.reason}`)
      } else {
        throw new Error('Payment timed out — no result within deadline')
      }
    } catch (err) {
      await this.handleSessionFailure(sessionReady, 'pay')
      throw err
    }
  }

  async payWhileRunning(destination: string, amountMsat?: number, waitForPaymentSecs?: number): Promise<PaymentResult> {
    return this.pay(destination, amountMsat, waitForPaymentSecs)
  }

  // ── Events ───────────────────────────────────────────────────────────────

  nextEvent(): PaymentEvent | null { return null }
  ackEvent(): void { /* no-op */ }

  // ── Balance & Channels ─────────────────────────────────────────────────

  async getNodeInfo(): Promise<NodeInfo> {
    this.assertNotDestroyed()
    let sessionReady = false

    try {
      await this.setupFromStorage()
      sessionReady = true
      const infoStr = get_info_on_session()
      const raw = JSON.parse(infoStr) as WasmNodeInfo
      const result: NodeInfo = {
        balanceSats: Math.floor(raw.total_balance_msat / 1000),
        channels: (raw.channels || []).map((ch) => ({
          channelId: ch.channel_id,
          counterpartyNodeId: ch.counterparty_node_id,
          shortChannelId: undefined,
          inboundCapacityMsat: ch.inbound_capacity_msat,
          outboundCapacityMsat: ch.outbound_capacity_msat,
          isChannelReady: ch.is_channel_ready,
          isUsable: ch.is_usable,
          isPublic: false,
        })),
      }
      await this.persistSessionEnd()
      teardown_node()
      return result
    } catch (err) {
      await this.handleSessionFailure(sessionReady, 'getNodeInfo')
      throw err
    }
  }

  async getBalance(): Promise<number> {
    const info = await this.getNodeInfo()
    return info.balanceSats
  }

  async getBalanceWhileRunning(): Promise<number> {
    return this.getBalance()
  }

  async syncWallets(): Promise<void> {
    // Chain sync happens implicitly during getBalance/receivePayments
  }

  syncRgs(_doFullSync: boolean): number {
    // RGS sync happens automatically inside pay() — no manual sync needed
    return 0
  }

  async listChannels(): Promise<NodeChannel[]> {
    const info = await this.getNodeInfo()
    return info.channels
  }

  // ── Receiving (JS-driven pump loop) ────────────────────────────────────

  /**
   * Connect to LSP, claim pending payments, persist state to DO storage.
   * Uses JS-driven pump loop — no heavy WASM async state machine.
   */
  async receivePayments(_minThresholdMs?: number, _quietThresholdMs?: number): Promise<ReceivedPayment[]> {
    this.assertNotDestroyed()
    const fetcher = createFetcher()
    const connector = createConnector()
    let sessionReady = false

    try {
      await this.setupFromStorage()
      sessionReady = true
      timer_tick()  // lightweight timer ticks (no rebroadcast — alarm handles that)

      const socket = await connector.connect(this.lspHost, this.lspPort)
      const handshakeHex = initiate_connection(this.lspPubkey)
      await socket.write(hexToBytes(handshakeHex))

      const pumpResult = await pumpLoop(socket, this.storage, {
        waitForClaims: true,
        timeoutMs: 8_000,
        quietTimeoutMs: 1_000,
      })
      socket.close()

      await flush_broadcasts_on_session(fetcher)
      await this.persistSessionEnd()
      teardown_node()

      return pumpResult.allClaimed.map((p) => ({
        paymentHash: p.payment_hash,
        amount: Math.floor(p.amount_msat / 1000),
      }))
    } catch (err) {
      await this.handleSessionFailure(sessionReady, 'receivePayments')
      throw err
    }
  }

  // ── BOLT12 (not supported) ───────────────────────────────────────────────

  setupBolt12Receive(): void {
    throw new Error('BOLT12 is not supported on CF Workers')
  }

  getBolt12OfferWhileRunning(_amount?: number, _description?: string, _expirySecs?: number): string {
    throw new Error('BOLT12 is not supported on CF Workers')
  }

  getVariableAmountBolt12OfferWhileRunning(_description: string, _expirySecs?: number): string {
    throw new Error('BOLT12 is not supported on CF Workers')
  }
}
