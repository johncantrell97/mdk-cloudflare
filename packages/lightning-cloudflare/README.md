# mdk-cloudflare

Lightning payments for Cloudflare Workers via a SQLite-backed Durable Object.

`mdk-cloudflare` is the backend package in this repo. It gives you:

- `LightningNode`, a Durable Object class that runs LDK compiled to WASM
- Worker-safe checkout, payment, and node APIs
- `mppCharge()`, an [MPP](https://mpp.dev)-compatible helper for pay-per-request endpoints with Lightning
- `createUnifiedHandler()`, an upstream-style `/api/mdk` route for MoneyDevKit checkout flows

Documentation:

- Repo README: https://github.com/johncantrell97/mdk-cloudflare/blob/main/README.md
- Integration docs: https://github.com/johncantrell97/mdk-cloudflare/blob/main/CHECKOUT_PAGE_SETUP.md
- Architecture guide: https://github.com/johncantrell97/mdk-cloudflare/blob/main/ARCHITECTURE.md
- Agent integration guide: https://github.com/johncantrell97/mdk-cloudflare/blob/main/llms.txt

## Install

```bash
npm install mdk-cloudflare
```

Current public support: `mainnet` only.

## Quick Start

`tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noEmit": true,
    "types": ["@cloudflare/workers-types"]
  }
}
```

`wrangler.toml`

```toml
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]

[[durable_objects.bindings]]
name = "LIGHTNING_NODE"
class_name = "LightningNode"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["LightningNode"]
```

Important:

- Use `new_sqlite_classes`, not `new_classes`.
- Re-export `LightningNode` from your Worker entry.

`worker.ts`

```ts
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
```

Secrets:

```bash
wrangler secret put MNEMONIC
wrangler secret put MDK_ACCESS_TOKEN
```

For local development with `wrangler dev`, put those values in `.dev.vars` next to `wrangler.toml`.

`/api/mdk` uses `MDK_ACCESS_TOKEN` for inbound secret-authenticated MDK server requests. MoneyDevKit Standard Webhooks for app-level events are a separate integration and should use their own endpoint and `whsec_...` signing secret.

## What `/api/mdk` Supports

`createUnifiedHandler()` handles:

- `create_checkout`
- `get_checkout`
- `confirm_checkout`
- `list_products`
- `get_customer`
- signed `GET /api/mdk?action=createCheckout...`
- webhook forwarding with secret auth

## API Shape

All node methods are called through DO RPC on the stub returned by `env.LIGHTNING_NODE.get(...)`.

```ts
const checkout = await node.createCheckout({ amount: 1000, currency: 'SAT' })
const confirmed = await node.confirmCheckout({ checkoutId: checkout.id })
const current = await node.getCheckout(checkout.id)
const products = await node.listProducts()
const customer = await node.getCustomer({ email: 'buyer@example.com' })
const payment = await node.pay('lnbc10u1p...')
const nodeId = await node.getNodeId()
const info = await node.getNodeInfo()
const debug = await node.debug()
```

Utilities are also exported:

```ts
import {
  mppCharge,
  createCheckoutUrl,
  createUnifiedHandler,
  resolveDestinationToInvoice,
  parseBolt11AmountMsat,
  setLogLevel,
} from 'mdk-cloudflare'
```

## MPP (Machine Payments Protocol)

`mppCharge()` lets you create HTTP 402-protected endpoints that require Lightning payment before your handler runs. It implements the [Machine Payments Protocol](https://mpp.dev) `charge` intent with the `lightning` payment method.

```ts
import { LightningNode, mppCharge } from 'mdk-cloudflare'

export { LightningNode }

interface Env {
  LIGHTNING_NODE: DurableObjectNamespace<LightningNode>
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const node = env.LIGHTNING_NODE.get(env.LIGHTNING_NODE.idFromName('default'))

    return mppCharge(request, node, { amount: 100 }, async () => {
      return Response.json({ data: 'premium content' })
    })
  },
}
```

**How it works:**

1. Client requests a protected endpoint — gets HTTP 402 with a Lightning invoice in the `WWW-Authenticate` header
2. Client pays the invoice with any Lightning wallet — receives a payment preimage
3. Client retries the request with `Authorization: Payment` header containing the preimage
4. Server verifies `SHA256(preimage) === paymentHash`, runs the handler, returns the response with a `Payment-Receipt`

Each payment is single-use — the challenge is deleted after successful verification, preventing replay.

**Dynamic pricing** — set `amount` to a function of the request:

```ts
mppCharge(request, node, {
  amount: async (req) => {
    const { sizeMb } = await req.json()
    return sizeMb * 50 // 50 sats per MB
  }
}, handler)
```

Compatible with MPP clients like [`mppx`](https://www.npmjs.com/package/mppx).

## Pairing With React Checkout

If you want the official MoneyDevKit buyer-facing checkout page UI in a React app, install:

```bash
npm install @moneydevkit/core react react-dom
```

Then keep your Worker serving `/api/mdk` and mount the upstream React checkout component in your frontend:

```tsx
import '@moneydevkit/core/mdk-styles.css'
import { Checkout } from '@moneydevkit/core/client'

export function CheckoutRoute() {
  return <Checkout id="chk_123" />
}
```

The React examples in this repo show how to pair that UI with a Cloudflare Worker app shell.

## Examples

- Basic Worker: https://github.com/johncantrell97/mdk-cloudflare/tree/main/examples/basic-worker
- React + Vite checkout pages: https://github.com/johncantrell97/mdk-cloudflare/tree/main/examples/react-vite-worker
- React Router checkout pages: https://github.com/johncantrell97/mdk-cloudflare/tree/main/examples/react-router-worker
- MPP pay-per-request: https://github.com/johncantrell97/mdk-cloudflare/tree/main/examples/mpp-worker
