/**
 * Example: MPP-protected API endpoint using mdk-cloudflare.
 *
 * Any request to /api/paid requires a Lightning payment before the handler runs.
 * The mppCharge() helper handles the full 402 challenge-response cycle.
 *
 * Test with an MPP-compatible client:
 *   npx mppx http://localhost:8787/api/paid
 */

import { LightningNode, mppCharge, createUnifiedHandler } from 'mdk-cloudflare'

// Required: re-export DO class so CF runtime can instantiate it
export { LightningNode }

interface Env {
  LIGHTNING_NODE: DurableObjectNamespace<LightningNode>
  MDK_ACCESS_TOKEN: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const node = env.LIGHTNING_NODE.get(env.LIGHTNING_NODE.idFromName('default'))

    // MDK webhook handler (required for incoming payment processing)
    if (url.pathname === '/api/mdk') {
      return createUnifiedHandler({ node, accessToken: env.MDK_ACCESS_TOKEN })(request)
    }

    // Pay-per-request endpoint: 100 sats
    if (url.pathname === '/api/paid') {
      return mppCharge(request, node, { amount: 100 }, async () => {
        return Response.json({
          message: 'Payment received! Here is your premium content.',
          timestamp: new Date().toISOString(),
        })
      })
    }

    // Dynamic pricing example: 50 sats per MB
    if (url.pathname === '/api/transcribe' && request.method === 'POST') {
      return mppCharge(request, node, {
        amount: async (req) => {
          const body = await req.json() as { fileSizeMb?: number }
          const sizeMb = body.fileSizeMb ?? 1
          return Math.max(50, Math.ceil(sizeMb * 50))
        },
      }, async () => {
        return Response.json({ status: 'transcription started' })
      })
    }

    if (url.pathname === '/') {
      return new Response('MPP Worker Example. Try GET /api/paid with an MPP client.', {
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    return new Response('Not found', { status: 404 })
  },
}
