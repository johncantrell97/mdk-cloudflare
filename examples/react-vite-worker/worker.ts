import { LightningNode, createUnifiedHandler } from 'mdk-cloudflare'

export { LightningNode }

interface Env {
  LIGHTNING_NODE: DurableObjectNamespace<LightningNode>
  MDK_ACCESS_TOKEN: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const node = env.LIGHTNING_NODE.get(env.LIGHTNING_NODE.idFromName('default'))

    if (url.pathname === '/api/mdk') {
      return createUnifiedHandler({
        node,
        accessToken: env.MDK_ACCESS_TOKEN,
      })(request)
    }

    return new Response('Not found', { status: 404 })
  },
}
