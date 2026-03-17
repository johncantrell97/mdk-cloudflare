const BECH32_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

function bech32Decode(str: string): Uint8Array {
  str = str.toLowerCase()
  const sepIdx = str.lastIndexOf('1')
  if (sepIdx < 1) throw new Error('Invalid bech32: no separator')
  const data = str.slice(sepIdx + 1)

  const values: number[] = []
  for (const ch of data) {
    const idx = BECH32_ALPHABET.indexOf(ch)
    if (idx === -1) throw new Error(`Invalid bech32 character: ${ch}`)
    values.push(idx)
  }

  // Strip 6-character checksum
  const payload = values.slice(0, -6)

  // Convert 5-bit groups to 8-bit bytes
  let acc = 0
  let bits = 0
  const bytes: number[] = []
  for (const v of payload) {
    acc = (acc << 5) | v
    bits += 5
    while (bits >= 8) {
      bits -= 8
      bytes.push((acc >> bits) & 0xff)
    }
  }
  return new Uint8Array(bytes)
}

export function parseDestinationToUrl(destination: string): string {
  if (!destination) {
    throw new Error('Invalid WITHDRAWAL_DESTINATION format')
  }

  if (destination.includes('@')) {
    const [user, domain] = destination.split('@', 2)
    if (!user || !domain || !domain.includes('.')) {
      throw new Error('Invalid WITHDRAWAL_DESTINATION format')
    }
    return `https://${domain}/.well-known/lnurlp/${user}`
  }

  if (destination.toLowerCase().startsWith('lnurl1')) {
    const bytes = bech32Decode(destination)
    return new TextDecoder().decode(bytes)
  }

  throw new Error('Invalid WITHDRAWAL_DESTINATION format')
}

// Longest prefix first — Array.find stops at first match, so 'lnbcrt' must precede 'lnbc'.
const BOLT11_PREFIXES = ['lnbcrt', 'lntbs', 'lntb', 'lnbc']

const BTC_TO_MSAT = 100_000_000_000n

// Multipliers convert the numeric amount to msat.
// For p (pico-BTC), 1 pBTC = 0.1 msat, so we use a special divisor.
const MULTIPLIERS: Record<string, bigint> = {
  m: 100_000_000n,
  u: 100_000n,
  n: 100n,
}

const PICO_DIVISOR = 10n

export function parseBolt11AmountMsat(invoice: string): bigint | null {
  const lower = invoice.toLowerCase()
  const prefix = BOLT11_PREFIXES.find(p => lower.startsWith(p))
  if (!prefix) return null

  const afterPrefix = lower.slice(prefix.length)

  // The bech32 separator is the LAST '1' in the string.
  const sepIdx = afterPrefix.lastIndexOf('1')
  if (sepIdx <= 0) return null

  const amountPart = afterPrefix.slice(0, sepIdx)
  if (!amountPart) return null

  const lastChar = amountPart[amountPart.length - 1]
  const multiplier = MULTIPLIERS[lastChar]

  if (multiplier) {
    const numStr = amountPart.slice(0, -1)
    if (!numStr || !/^\d+$/.test(numStr)) return null
    return BigInt(numStr) * multiplier
  }

  if (lastChar === 'p') {
    const numStr = amountPart.slice(0, -1)
    if (!numStr || !/^\d+$/.test(numStr)) return null
    const raw = BigInt(numStr)
    if (raw % PICO_DIVISOR !== 0n) return null
    return raw / PICO_DIVISOR
  }

  if (!/^\d+$/.test(amountPart)) return null
  return BigInt(amountPart) * BTC_TO_MSAT
}

const LNURL_HEADERS = {
  'Accept': 'application/json',
  'User-Agent': 'mdk-cloudflare/1.0',
}

interface LnurlError {
  status?: string
  reason?: string
}

export async function resolveDestinationToInvoice(
  destination: string,
  amountMsat: number,
): Promise<string> {
  const url = parseDestinationToUrl(destination)

  const metaRes = await fetch(url, { headers: LNURL_HEADERS })
  if (!metaRes.ok) {
    throw new Error(`LNURL resolution failed: HTTP ${metaRes.status}`)
  }

  const meta = await metaRes.json() as LnurlError & {
    tag?: string
    callback?: string
    minSendable?: number
    maxSendable?: number
  }

  if (meta.status === 'ERROR') {
    throw new Error(`LNURL endpoint error: ${meta.reason ?? 'unknown'}`)
  }

  if (meta.tag !== 'payRequest') {
    throw new Error('LNURL endpoint is not a pay request')
  }

  if (!meta.callback) {
    throw new Error('LNURL resolution failed: no callback URL')
  }

  const min = meta.minSendable ?? 0
  const max = meta.maxSendable ?? Infinity
  if (amountMsat < min || amountMsat > max) {
    throw new Error(
      `Amount ${amountMsat} msat outside allowed range [${min}, ${max}]`
    )
  }

  const sep = meta.callback.includes('?') ? '&' : '?'
  const callbackUrl = `${meta.callback}${sep}amount=${amountMsat}`
  const invoiceRes = await fetch(callbackUrl, { headers: LNURL_HEADERS })
  if (!invoiceRes.ok) {
    throw new Error(`LNURL resolution failed: callback HTTP ${invoiceRes.status}`)
  }

  const invoiceData = await invoiceRes.json() as LnurlError & { pr?: string }
  if (invoiceData.status === 'ERROR') {
    throw new Error(`LNURL callback error: ${invoiceData.reason ?? 'unknown'}`)
  }
  if (!invoiceData.pr) {
    throw new Error('LNURL callback did not return an invoice')
  }

  const invoiceAmountMsat = parseBolt11AmountMsat(invoiceData.pr)
  if (invoiceAmountMsat !== null && invoiceAmountMsat !== BigInt(amountMsat)) {
    throw new Error(
      `Invoice amount mismatch: requested ${amountMsat} msat, got ${invoiceAmountMsat} msat`
    )
  }

  return invoiceData.pr
}
