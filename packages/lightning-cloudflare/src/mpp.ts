// --- Base64url ---

/** @internal */
export function base64urlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** @internal */
export function base64urlDecode(encoded: string): string {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (encoded.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

// --- MPP Types ---

/** Challenge data returned when creating an MPP payment challenge. */
export interface MppChallenge {
  challengeId: string
  invoice: string
  paymentHash: string
  amountSats: number
  expiresAt: number
}

/** Result of verifying an MPP payment credential. */
export interface MppVerification {
  valid: boolean
  paymentHash?: string
}

/** Interface for the DO stub passed to {@link mppCharge}. Matches the `LightningNode` RPC shape. */
export interface MppChargeNode {
  createMppChallenge(amountSats: number): Promise<MppChallenge>
  verifyMppCredential(challengeId: string, preimage: string): Promise<MppVerification>
}

type MppAmountFn = (request: Request) => number | Promise<number>

/** Options for {@link mppCharge}. */
export interface MppChargeOptions {
  amount: number | MppAmountFn
}

// --- Header parsing ---

interface ParsedCredential {
  id: string
  preimage: string
}

/** @internal */
export function parsePaymentAuthorization(header: string | null): ParsedCredential | null {
  if (!header || !header.startsWith('Payment ')) return null

  const content = header.slice('Payment '.length).trim()

  // Try mppx blob format first: Payment <base64url({challenge, payload})>
  // The blob doesn't contain '=' at the start or '"', it's a single base64url token
  if (!content.includes('="')) {
    try {
      const decoded = JSON.parse(base64urlDecode(content)) as {
        challenge?: { id?: string }
        payload?: { preimage?: string }
      }
      if (typeof decoded.challenge?.id === 'string' && typeof decoded.payload?.preimage === 'string') {
        return { id: decoded.challenge.id, preimage: decoded.payload.preimage }
      }
    } catch {
      // Not valid base64/JSON, fall through to param-style
    }
  }

  // Param-style format: Payment id="...",payload="..."
  const idMatch = content.match(/id="([^"]+)"/)
  const payloadMatch = content.match(/payload="([^"]+)"/)

  if (!idMatch || !payloadMatch) return null

  try {
    const payload = JSON.parse(base64urlDecode(payloadMatch[1])) as Record<string, unknown>
    if (typeof payload.preimage !== 'string') return null
    return { id: idMatch[1], preimage: payload.preimage }
  } catch {
    return null
  }
}

/** @internal */
export function formatWwwAuthenticate(challenge: MppChallenge): string {
  const requestJson = JSON.stringify({
    amount: String(challenge.amountSats),
    currency: 'sat',
    methodDetails: {
      invoice: challenge.invoice,
      paymentHash: challenge.paymentHash,
      network: 'mainnet',
    },
  })
  const request = base64urlEncode(requestJson)
  const expires = new Date(challenge.expiresAt * 1000).toISOString()
  return `Payment realm="mdk-cloudflare",id="${challenge.challengeId}",method="lightning",intent="charge",request="${request}",expires="${expires}"`
}

function formatReceipt(paymentHash: string): string {
  return base64urlEncode(JSON.stringify({
    method: 'lightning',
    reference: paymentHash,
    status: 'success',
    timestamp: new Date().toISOString(),
  }))
}

/**
 * Wrap a request handler with MPP (Machine Payments Protocol) Lightning payment gating.
 *
 * On first request (no `Authorization: Payment` header), creates a Lightning invoice via
 * the DO and returns HTTP 402 with a `WWW-Authenticate` challenge. On retry with a valid
 * payment preimage, verifies the preimage, runs the handler, and attaches a `Payment-Receipt`.
 *
 * @example
 * ```ts
 * // Static pricing: 100 sats per request
 * return mppCharge(request, node, { amount: 100 }, async () => {
 *   return Response.json({ data: 'premium content' })
 * })
 *
 * // Dynamic pricing based on request body
 * return mppCharge(request, node, {
 *   amount: async (req) => {
 *     const { sizeMb } = await req.json()
 *     return sizeMb * 50
 *   }
 * }, async () => {
 *   return Response.json({ status: 'processing' })
 * })
 * ```
 */
export async function mppCharge(
  request: Request,
  node: MppChargeNode,
  options: MppChargeOptions,
  handler: () => Response | Promise<Response>,
): Promise<Response> {
  const clonedRequest = request.clone()

  const credential = parsePaymentAuthorization(request.headers.get('Authorization'))

  // --- Has credential: verify ---
  if (credential) {
    try {
      const result = await node.verifyMppCredential(credential.id, credential.preimage)

      if (!result.valid) {
        // Issue a fresh challenge so mppx clients can retry
        const amount = typeof options.amount === 'function'
          ? await options.amount(clonedRequest)
          : options.amount
        const freshChallenge = await node.createMppChallenge(amount)
        return new Response(JSON.stringify({
          error: 'Payment Required',
          method: 'lightning',
          invoice: freshChallenge.invoice,
        }), {
          status: 402,
          headers: {
            'Content-Type': 'application/json',
            'WWW-Authenticate': formatWwwAuthenticate(freshChallenge),
            'Cache-Control': 'no-store',
          },
        })
      }

      const response = await handler()
      const receipt = formatReceipt(result.paymentHash!)
      const newResponse = new Response(response.body, response)
      newResponse.headers.set('Payment-Receipt', receipt)
      return newResponse
    } catch {
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }

  // --- No credential: issue challenge ---
  try {
    const amount = typeof options.amount === 'function'
      ? await options.amount(clonedRequest)
      : options.amount

    const challenge = await node.createMppChallenge(amount)

    return new Response(JSON.stringify({
      error: 'Payment Required',
      method: 'lightning',
      invoice: challenge.invoice,
    }), {
      status: 402,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': formatWwwAuthenticate(challenge),
        'Cache-Control': 'no-store',
      },
    })
  } catch {
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
