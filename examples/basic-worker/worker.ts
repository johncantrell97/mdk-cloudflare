/**
 * Example Cloudflare Worker using the LightningNode Durable Object.
 *
 * This demonstrates how to integrate mdk-cloudflare into your own
 * Worker project. The Worker acts as a thin HTTP router that forwards requests
 * to the DO, which handles all Lightning node operations.
 *
 * Setup:
 *   1. Copy this file and wrangler.toml into your project
 *   2. npm install mdk-cloudflare
 *   3. wrangler secret put MNEMONIC
 *   4. wrangler secret put MDK_ACCESS_TOKEN
 *   5. wrangler deploy
 */

import { LightningNode, createUnifiedHandler } from 'mdk-cloudflare'
import type { CreateCheckoutOptions } from 'mdk-cloudflare'
import { renderDashboard } from './dashboard.js'

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

    // Unified MDK route:
    // - browser-facing checkout API (`create_checkout`, `get_checkout`, `confirm_checkout`, etc.)
    // - signed GET checkout links
    // - webhook forwarding for incoming payments
    if (url.pathname === '/api/mdk') {
      return createUnifiedHandler({
        node,
        accessToken: env.MDK_ACCESS_TOKEN,
      })(request)
    }

    // Create checkout
    if (url.pathname === '/api/checkout' && request.method === 'POST') {
      const body = (await request.json()) as CreateCheckoutOptions
      const checkout = await node.createCheckout(body)
      return Response.json(checkout)
    }

    // Poll checkout status (for frontend)
    if (url.pathname.startsWith('/api/checkout/') && request.method === 'GET') {
      const id = url.pathname.split('/').pop()!
      const checkout = await node.getCheckout(id)
      return Response.json(checkout)
    }

    // Node info
    if (url.pathname === '/api/info') {
      const info = await node.getNodeInfo()
      return Response.json(info)
    }

    // Debug
    if (url.pathname === '/api/debug') {
      const debug = await node.debug()
      return Response.json(debug)
    }

    // Node ID (lightweight, no WASM node restore)
    if (url.pathname === '/api/node-id') {
      const nodeId = await node.getNodeId()
      return Response.json({ nodeId })
    }

    // Pay a BOLT11 invoice
    if (url.pathname === '/api/pay' && request.method === 'POST') {
      const { bolt11 } = (await request.json()) as { bolt11: string }
      const result = await node.pay(bolt11)
      return Response.json(result)
    }

    // Dashboard
    if (url.pathname === '/' || url.pathname === '/dashboard') {
      return new Response(renderDashboard(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    return new Response('Not found', { status: 404 })
  },
}
