import wasmModule from 'ldk-wasm/ldk_wasm_bg.wasm'
import { initSync } from 'ldk-wasm'
import type { PaymentMetadata } from './types.js'

let wasmInitialized = false

export function ensureWasm() {
  if (!wasmInitialized) {
    initSync({ module: wasmModule })
    wasmInitialized = true
  }
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16)
  }
  return bytes
}

export function parseInvoiceDetails(detailsJson: string): PaymentMetadata {
  const d = JSON.parse(detailsJson) as { invoice: string; paymentHash: string; expiresAt: number; scid: string }
  return { bolt11: d.invoice, paymentHash: d.paymentHash, expiresAt: d.expiresAt, scid: d.scid }
}
